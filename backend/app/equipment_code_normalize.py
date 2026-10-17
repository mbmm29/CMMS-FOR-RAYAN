"""Normalize equipment codes: drop leading letter + dash, keep the number (and -2 suffixes)."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import Equipment

_CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'add_equipment_catalog.json'

# Child / related columns that store an equipment code (FK or plain text).
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
    """Public helper for create/import."""
    return strip_leading_letter_dash(code)


def build_equipment_code_map(codes: list[str]) -> dict[str, str]:
    """
    Map old codes → normalized codes.
    Keep the original number length. Only when two plants share the same number
    (A-1062 and B-1062), the second becomes 1062-2, 1062-3, ...
    """
    preferred: dict[str, str] = {}
    for code in codes:
        raw = str(code or '').strip()
        if not raw:
            continue
        preferred[raw] = strip_leading_letter_dash(raw)

    groups: dict[str, list[str]] = defaultdict(list)
    for old, base in preferred.items():
        groups[base].append(old)

    def sort_key(value: str):
        match = re.match(r'^([A-Za-z])', value or '')
        return (match.group(1).upper() if match else 'Z', value)

    mapping: dict[str, str] = {}
    for base, items in groups.items():
        # A- before B- so the first plant keeps the plain number (1062), the next becomes 1062-2.
        unique_items = sorted(set(items), key=sort_key)
        for index, old in enumerate(unique_items):
            mapping[old] = base if index == 0 else f'{base}-{index + 1}'
    return mapping


def _load_catalog_rows() -> list[dict]:
    if not _CATALOG_PATH.exists():
        return []
    payload = json.loads(_CATALOG_PATH.read_text(encoding='utf-8'))
    rows = payload.get('rows') if isinstance(payload, dict) else payload
    return rows if isinstance(rows, list) else []


def catalog_alias_map() -> dict[str, str]:
    """
    Build rename map from catalog source codes.
    Includes previous bad ids (10621) so a second deploy can correct them.
    """
    rows = _load_catalog_rows()
    sources = []
    for row in rows:
        source = str(row.get('source_code') or row.get('equipment_id') or '').strip()
        if source:
            sources.append(source)
    source_map = build_equipment_code_map(sources)
    aliases: dict[str, str] = {}
    for row in rows:
        source = str(row.get('source_code') or '').strip()
        current = str(row.get('equipment_id') or '').strip()
        if not source:
            continue
        final = source_map.get(source) or strip_leading_letter_dash(source)
        aliases[source] = final
        if current:
            aliases[current] = final
        # Previous bad collision form: digits + letter-rank (A-1062 → 10621).
        digits = re.sub(r'\D+', '', source)
        rank_match = re.match(r'^([A-Za-z])', source)
        if digits and rank_match:
            rank = str(ord(rank_match.group(1).upper()) - ord('A') + 1)
            aliases[f'{digits}{rank}'] = final
    return aliases


def _table_exists(db: Session, table: str) -> bool:
    row = db.execute(
        text('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = :table'),
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


def _update_code_column(db: Session, table: str, column: str, old: str, new: str) -> int:
    if not _table_exists(db, table) or not _column_exists(db, table, column):
        return 0
    result = db.execute(
        text(f'UPDATE {table} SET {column} = :new WHERE {column} = :old'),
        {'old': old, 'new': new},
    )
    return result.rowcount or 0


def _clone_equipment_row(db: Session, old: str, new: str) -> None:
    source = db.query(Equipment).filter_by(equipment_id=old).first()
    if not source:
        return
    payload = {
        column.name: getattr(source, column.name)
        for column in Equipment.__table__.columns
        if column.name != 'id'
    }
    payload['equipment_id'] = new
    db.add(Equipment(**payload))
    db.flush()


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


def rename_equipment_codes(db: Session, mapping: dict[str, str] | None = None) -> dict:
    rows = db.query(Equipment).order_by(Equipment.equipment_id).all()
    codes = [row.equipment_id for row in rows if row.equipment_id]
    if mapping is None:
        aliases = catalog_alias_map()
        generated = build_equipment_code_map(codes)
        mapping = {}
        for code in codes:
            mapping[code] = aliases.get(code) or generated.get(code) or strip_leading_letter_dash(code)
    mapping = {old: new for old, new in mapping.items() if old and new and old != new}
    if not mapping:
        return {'renamed': 0, 'skipped': len(codes), 'samples': []}

    ordered = sorted(mapping.items(), key=lambda item: (-len(item[0]), item[0]))
    renamed = 0
    samples = []
    for old, new in ordered:
        current = db.query(Equipment).filter_by(equipment_id=old).first()
        if not current:
            continue
        target = db.query(Equipment).filter_by(equipment_id=new).first()
        if target and target.id != current.id:
            for table, column in _EQUIPMENT_CODE_COLUMNS:
                _update_code_column(db, table, column, old, new)
            _dedupe_spare_links(db)
            db.delete(current)
            renamed += 1
            if len(samples) < 12:
                samples.append({'old': old, 'new': new, 'merged': True})
            continue

        _clone_equipment_row(db, old, new)
        for table, column in _EQUIPMENT_CODE_COLUMNS:
            _update_code_column(db, table, column, old, new)
        db.execute(text('DELETE FROM equipment WHERE equipment_id = :old'), {'old': old})
        renamed += 1
        if len(samples) < 12:
            samples.append({'old': old, 'new': new, 'merged': False})

    db.commit()
    return {'renamed': renamed, 'skipped': len(codes) - renamed, 'samples': samples}


def maybe_normalize_equipment_codes(db: Session) -> dict | None:
    """Rename while any code still has a leading letter, or still uses the old 5-digit collision form."""
    aliases = catalog_alias_map()
    rows = db.query(Equipment).all()
    mapping = {}
    for row in rows:
        code = row.equipment_id or ''
        desired = aliases.get(code)
        if not desired:
            desired = strip_leading_letter_dash(code)
        if desired and desired != code:
            mapping[code] = desired
        elif re.search(r'[A-Za-z]', code):
            mapping[code] = strip_leading_letter_dash(code)
    if not mapping:
        return None
    return rename_equipment_codes(db, mapping)
