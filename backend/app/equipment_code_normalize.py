"""Normalize equipment codes to digits only (drop leading letters and dashes)."""
from __future__ import annotations

import re
from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import Equipment

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


def digits_only(code: str | None) -> str:
    return re.sub(r'\D+', '', str(code or '').strip())


def normalize_equipment_code(code: str | None) -> str:
    """Public helper for create/import: keep digits only."""
    cleaned = digits_only(code)
    return cleaned or str(code or '').strip()


def _letter_rank(code: str) -> str:
    match = re.match(r'^([A-Za-z])', str(code or '').strip())
    if not match:
        return ''
    return str(ord(match.group(1).upper()) - ord('A') + 1)


def build_equipment_code_map(codes: list[str]) -> dict[str, str]:
    """Map old codes → numeric codes. Collisions append a letter-rank digit (A=1, B=2)."""
    groups: dict[str, list[str]] = defaultdict(list)
    for code in codes:
        raw = str(code or '').strip()
        if not raw:
            continue
        groups[digits_only(raw) or raw].append(raw)

    mapping: dict[str, str] = {}
    taken: set[str] = set()
    for digits, items in groups.items():
        unique_items = sorted(set(items))
        if len(unique_items) == 1:
            old = unique_items[0]
            new = digits_only(old) or old
            mapping[old] = new
            taken.add(new)
            continue
        for old in unique_items:
            base = digits_only(old) or old
            rank = _letter_rank(old)
            candidate = f'{base}{rank}' if rank else base
            if not candidate:
                candidate = old
            n = 2
            root = candidate
            while candidate in taken:
                candidate = f'{root}{n}'
                n += 1
            mapping[old] = candidate
            taken.add(candidate)
    return mapping


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


def rename_equipment_codes(db: Session) -> dict:
    rows = db.query(Equipment).order_by(Equipment.equipment_id).all()
    codes = [row.equipment_id for row in rows if row.equipment_id]
    mapping = {
        old: new
        for old, new in build_equipment_code_map(codes).items()
        if old != new
    }
    if not mapping:
        return {'renamed': 0, 'skipped': len(codes), 'samples': []}

    # Rename longer codes first so temporary overlaps are less likely.
    ordered = sorted(mapping.items(), key=lambda item: (-len(item[0]), item[0]))
    renamed = 0
    samples = []
    for old, new in ordered:
        current = db.query(Equipment).filter_by(equipment_id=old).first()
        if not current:
            continue
        target = db.query(Equipment).filter_by(equipment_id=new).first()
        if target and target.id != current.id:
            # Collision with an existing numeric machine: keep the existing one and
            # move references from the letter-prefixed row onto it, then delete.
            for table, column in _EQUIPMENT_CODE_COLUMNS:
                _update_code_column(db, table, column, old, new)
            # Spare unique pairs may collide after merge — drop exact dupes.
            if _table_exists(db, 'spare_part_equipment'):
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
    """Run once while any equipment code still contains a letter or dash."""
    needs = db.query(Equipment).filter(
        Equipment.equipment_id.op('~')(r'[A-Za-z-]')
    ).first()
    if not needs:
        return None
    return rename_equipment_codes(db)
