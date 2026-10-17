"""Normalize equipment codes: strip leading letter + dash; codes may repeat across plant/line."""
from __future__ import annotations

import json
import re
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import Equipment

_CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'add_equipment_catalog.json'

_EQUIPMENT_CODE_COLUMNS = (
    ('components', 'equipment_id'),
    ('pm_plans', 'equipment_id'),
    ('pm_plans', 'manual_equipment_code'),
    ('sops', 'equipment_id'),
    ('sop_paragraphs', 'equipment_id'),
    ('sop_manuals', 'equipment_id'),
    ('work_orders', 'equipment_id'),
    ('work_orders', 'manual_equipment_code'),
    ('daily_reports', 'equipment_id'),
    ('daily_report_items', 'equipment_id'),
    ('daily_report_items', 'equipment_code'),
    ('pending_equipment', 'equipment_code'),
    ('machine_records', 'equipment_id'),
    ('kpi_targets', 'equipment_id'),
    ('measurements', 'equipment_id'),
    ('lubrication_lines', 'equipment_code'),
    ('motor_condition_readings', 'equipment_id'),
    ('parts_used', 'equipment_id'),
    ('spare_part_equipment', 'equipment_id'),
)


def strip_leading_letter_dash(code: str | None) -> str:
    """A-1050 → 1050, A-4215-2 → 4215-2, 3603 → 3603."""
    text_value = str(code or '').strip()
    cleaned = re.sub(r'^[A-Za-z]+-?', '', text_value)
    return cleaned or text_value


def normalize_equipment_code(code: str | None) -> str:
    return strip_leading_letter_dash(code)


def _table_exists(db: Session, table: str) -> bool:
    row = db.execute(
        text(
            'SELECT 1 FROM information_schema.tables '
            'WHERE table_schema = current_schema() AND table_name = :table'
        ),
        {'table': table},
    ).first()
    return bool(row)


def _column_exists(db: Session, table: str, column: str) -> bool:
    row = db.execute(
        text(
            'SELECT 1 FROM information_schema.columns '
            'WHERE table_schema = current_schema() AND table_name = :table AND column_name = :column'
        ),
        {'table': table, 'column': column},
    ).first()
    return bool(row)


def ensure_equipment_scope_constraints(db: Session) -> None:
    """Allow the same equipment_id on different plant/line pairs."""
    fks = db.execute(
        text(
            '''
            SELECT con.conname AS name, rel.relname AS table_name
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_class ref ON ref.oid = con.confrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE con.contype = 'f'
              AND nsp.nspname = current_schema()
              AND ref.relname = 'equipment'
            '''
        )
    ).mappings().all()
    for row in fks:
        db.execute(text(f'ALTER TABLE {row["table_name"]} DROP CONSTRAINT IF EXISTS {row["name"]}'))

    uniques = db.execute(
        text(
            '''
            SELECT c.conname AS name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype = 'u'
              AND n.nspname = current_schema()
              AND t.relname = 'equipment'
            '''
        )
    ).mappings().all()
    for row in uniques:
        db.execute(text(f'ALTER TABLE equipment DROP CONSTRAINT IF EXISTS {row["name"]}'))

    db.execute(text('DROP INDEX IF EXISTS equipment_equipment_id_key'))
    db.execute(text('DROP INDEX IF EXISTS ix_equipment_equipment_id'))
    db.execute(text('DROP INDEX IF EXISTS uq_equipment_plant_line_code'))

    db.execute(
        text(
            '''
            CREATE UNIQUE INDEX uq_equipment_plant_line_code
            ON equipment (plant_id, line_id, equipment_id)
            '''
        )
    )
    db.execute(text('CREATE INDEX IF NOT EXISTS ix_equipment_equipment_id ON equipment (equipment_id)'))

    if _table_exists(db, 'sop_manuals'):
        sop_uniques = db.execute(
            text(
                '''
                SELECT c.conname AS name
                FROM pg_constraint c
                JOIN pg_class t ON t.oid = c.conrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE c.contype = 'u'
                  AND n.nspname = current_schema()
                  AND t.relname = 'sop_manuals'
                '''
            )
        ).mappings().all()
        for row in sop_uniques:
            db.execute(text(f'ALTER TABLE sop_manuals DROP CONSTRAINT IF EXISTS {row["name"]}'))
        db.execute(text('DROP INDEX IF EXISTS sop_manuals_equipment_id_key'))
        db.execute(text('CREATE INDEX IF NOT EXISTS ix_sop_manuals_equipment_id ON sop_manuals (equipment_id)'))

    db.commit()


def _update_code_column(db: Session, table: str, column: str, old: str, new: str) -> int:
    if not _table_exists(db, table) or not _column_exists(db, table, column):
        return 0
    result = db.execute(
        text(f'UPDATE {table} SET {column} = :new WHERE {column} = :old'),
        {'old': old, 'new': new},
    )
    return result.rowcount or 0


def _dedupe_spare_links(db: Session) -> None:
    if not _table_exists(db, 'spare_part_equipment'):
        return
    db.execute(
        text(
            '''
            DELETE FROM spare_part_equipment a
            USING spare_part_equipment b
            WHERE a.id > b.id
              AND a.part_id = b.part_id
              AND a.equipment_id = b.equipment_id
            '''
        )
    )


def catalog_source_aliases() -> dict[str, str]:
    """Map previous codes (A-1062, 10621, 1062-2, …) → plain number from source_code."""
    if not _CATALOG_PATH.exists():
        return {}
    payload = json.loads(_CATALOG_PATH.read_text(encoding='utf-8'))
    rows = payload.get('rows') if isinstance(payload, dict) else payload
    aliases: dict[str, str] = {}
    if not isinstance(rows, list):
        return aliases
    for row in rows:
        source = str(row.get('source_code') or '').strip()
        current = str(row.get('equipment_id') or '').strip()
        if not source:
            continue
        final = strip_leading_letter_dash(source)
        aliases[source] = final
        if current:
            aliases[current] = final
        digits = re.sub(r'\D+', '', source)
        rank_match = re.match(r'^([A-Za-z])', source)
        if digits and rank_match:
            rank = str(ord(rank_match.group(1).upper()) - ord('A') + 1)
            aliases[f'{digits}{rank}'] = final
            aliases[f'{final}-{rank}'] = final
    return aliases


def rename_equipment_codes(db: Session) -> dict:
    """Rename each machine in place; same code on another plant/line is allowed."""
    ensure_equipment_scope_constraints(db)
    aliases = catalog_source_aliases()
    rows = db.query(Equipment).order_by(Equipment.id).all()
    renamed = 0
    samples = []
    for row in list(rows):
        old = row.equipment_id or ''
        desired = aliases.get(old) or strip_leading_letter_dash(old)
        if not desired or desired == old:
            continue

        same_scope = db.query(Equipment).filter(
            Equipment.equipment_id == desired,
            Equipment.plant_id == row.plant_id,
            Equipment.line_id == row.line_id,
            Equipment.id != row.id,
        ).first()
        if same_scope:
            for table, column in _EQUIPMENT_CODE_COLUMNS:
                _update_code_column(db, table, column, old, desired)
            _dedupe_spare_links(db)
            db.delete(row)
            renamed += 1
            if len(samples) < 12:
                samples.append({
                    'old': old,
                    'new': desired,
                    'plant_id': row.plant_id,
                    'line_id': row.line_id,
                    'merged': True,
                })
            continue

        row.equipment_id = desired
        for table, column in _EQUIPMENT_CODE_COLUMNS:
            _update_code_column(db, table, column, old, desired)
        _dedupe_spare_links(db)
        renamed += 1
        if len(samples) < 12:
            samples.append({
                'old': old,
                'new': desired,
                'plant_id': row.plant_id,
                'line_id': row.line_id,
                'merged': False,
            })

    db.commit()
    return {'renamed': renamed, 'samples': samples}


def maybe_normalize_equipment_codes(db: Session) -> dict | None:
    aliases = catalog_source_aliases()
    needs = False
    for row in db.query(Equipment).all():
        code = row.equipment_id or ''
        desired = aliases.get(code) or strip_leading_letter_dash(code)
        if desired != code or re.search(r'[A-Za-z]', code):
            needs = True
            break
    ensure_equipment_scope_constraints(db)
    if not needs:
        leftovers = [
            row for row in db.query(Equipment).all()
            if aliases.get(row.equipment_id) and aliases.get(row.equipment_id) != row.equipment_id
        ]
        if not leftovers:
            return None
    return rename_equipment_codes(db)
