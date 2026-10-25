"""Import mechanical warehouse spare parts from ميكانيك.pdf extract JSON."""
from __future__ import annotations

import json
import re
from pathlib import Path

from sqlalchemy.orm import Session

from .models import SparePart

CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'mekanik_spare_parts.json'
SOURCE_NOTE = 'ميكانيك.pdf'


def _clean(value) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def load_catalog(path: Path | None = None) -> list[dict]:
    file_path = path or CATALOG_PATH
    payload = json.loads(file_path.read_text(encoding='utf-8'))
    rows = payload.get('rows') if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError('Spare parts catalog has no rows')
    return rows


def _next_part_seq(db: Session) -> int:
    numbers = []
    for (value,) in db.query(SparePart.part_id).all():
        if value and value.startswith('SP-') and value[3:].isdigit():
            numbers.append(int(value[3:]))
    return (max(numbers) if numbers else 0) + 1


def import_mekanik_spare_parts(db: Session, update_existing: bool = True) -> dict:
    """Upsert Part No. / Part name / Stock from the mechanical warehouse PDF."""
    rows = load_catalog()
    existing = {
        (part.part_number or '').strip().lower(): part
        for part in db.query(SparePart).all()
    }
    seq = _next_part_seq(db)
    created = 0
    updated = 0
    skipped = 0

    for row in rows:
        number = _clean(row.get('part_number'))
        name = _clean(row.get('name'))
        if not number or not name:
            skipped += 1
            continue
        if len(name) > 200:
            name = name[:200]
        try:
            stock = row.get('stock_qty')
            stock_qty = None if stock is None or stock == '' else round(float(stock), 3)
        except (TypeError, ValueError):
            skipped += 1
            continue
        unit = _clean(row.get('unit') or 'pcs')[:30] or 'pcs'
        key = number.lower()
        part = existing.get(key)
        if part:
            if not update_existing:
                skipped += 1
                continue
            part.name = name
            part.stock_qty = stock_qty
            part.unit = unit
            if not (part.notes or '').strip():
                part.notes = SOURCE_NOTE
            updated += 1
            continue

        part_id = f'SP-{seq:05d}'
        seq += 1
        part = SparePart(
            part_id=part_id,
            part_number=number[:100],
            name=name,
            stock_qty=stock_qty,
            critical_qty=None,
            unit=unit,
            notes=SOURCE_NOTE,
        )
        db.add(part)
        existing[key] = part
        created += 1

    db.commit()
    return {
        'source': SOURCE_NOTE,
        'rows': len(rows),
        'created': created,
        'updated': updated,
        'skipped': skipped,
    }
