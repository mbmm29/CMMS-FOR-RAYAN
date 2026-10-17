"""Import equipment rows from the Add Equipment catalog JSON."""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

from sqlalchemy.orm import Session

from .models import Equipment, LineSection, Plant, PlantLine
from .equipment_code_normalize import normalize_equipment_code

CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'add_equipment_catalog.json'

PLANT_MATCHERS = (
    ('الاعلاف الاولى', ('الاعلاف الاولى', 'الاعلاف الأولى', 'اعلاف اولى', 'اعلاف أولى', 'first feed')),
    ('الاعلاف الثانيه', ('الاعلاف الثانيه', 'الاعلاف الثانية', 'اعلاف ثانيه', 'اعلاف ثانية', 'second feed')),
)

PLANT_DEFAULTS = {
    'الاعلاف الاولى': {'plant_id': 'FM01', 'order_code': 'FM1'},
    'الاعلاف الثانيه': {'plant_id': 'FM02', 'order_code': 'FM2'},
}


def _clean(value) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _fold(value: str) -> str:
    text = _clean(value).casefold()
    text = text.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه')
    return text


def load_catalog(path: Path | None = None) -> list[dict]:
    file_path = path or CATALOG_PATH
    payload = json.loads(file_path.read_text(encoding='utf-8'))
    rows = payload.get('rows') if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError('Catalog file has no rows')
    return rows


def parse_line(raw: str) -> tuple[int, str]:
    text = _clean(raw)
    match = re.match(r'(?i)^line\s*(\d+)$', text)
    if match:
        number = int(match.group(1))
        return number, f'Line {number}'
    match = re.match(r'(?i)^intake\s*(\d+)$', text)
    if match:
        number = int(match.group(1))
        return 100 + number, f'Intake {number}'
    if text.casefold() == 'line':
        return 99, 'Line'
    raise ValueError(f'Unrecognized line: {raw!r}')


def normalize_section_name(raw: str) -> str:
    name = _clean(raw)
    if not name:
        return ''
    if name.casefold() == 'baging':
        return 'Bagging'
    if name.casefold() == 'ppr':
        return 'PPR'
    if name.casefold() == 'outload':
        return 'Outload'
    if name.casefold() == 'otl':
        return 'OTL'
    return name


def match_plant_key(plant_name: str) -> str | None:
    folded = _fold(plant_name)
    for key, aliases in PLANT_MATCHERS:
        if any(_fold(alias) in folded or folded in _fold(alias) for alias in aliases):
            return key
    return None


def ensure_plant(db: Session, plant_name: str) -> Plant:
    key = match_plant_key(plant_name) or _clean(plant_name)
    defaults = PLANT_DEFAULTS.get(key, {})
    wanted_names = {key, _clean(plant_name)}
    plants = db.query(Plant).all()
    for plant in plants:
        if _fold(plant.name) in {_fold(name) for name in wanted_names}:
            return plant
        if key in PLANT_DEFAULTS and plant.plant_id == defaults.get('plant_id'):
            if _fold(plant.name) != _fold(key):
                plant.name = key
            return plant
    plant_id = defaults.get('plant_id') or f'PLANT-{abs(hash(key)) % 10000:04d}'
    while db.query(Plant).filter_by(plant_id=plant_id).first():
        plant_id = f'{plant_id}X'
    order_code = defaults.get('order_code')
    if order_code and db.query(Plant).filter(Plant.order_code == order_code).first():
        order_code = None
    plant = Plant(plant_id=plant_id, name=key, order_code=order_code, active=True)
    db.add(plant)
    db.flush()
    return plant


def ensure_line(db: Session, plant: Plant, line_raw: str) -> PlantLine:
    number, name = parse_line(line_raw)
    existing = db.query(PlantLine).filter_by(plant_id=plant.plant_id, line_number=number).first()
    if existing:
        if existing.name != name:
            existing.name = name
        existing.active = True
        return existing
    line_id = f'{plant.plant_id}-L{number}'
    while db.query(PlantLine).filter_by(line_id=line_id).first():
        line_id = f'{line_id}A'
    line = PlantLine(
        line_id=line_id,
        plant_id=plant.plant_id,
        line_number=number,
        name=name,
        active=True,
    )
    db.add(line)
    db.flush()
    return line


def ensure_section(db: Session, line: PlantLine, section_name: str) -> LineSection | None:
    name = normalize_section_name(section_name)
    if not name:
        return None
    existing = db.query(LineSection).filter_by(line_id=line.line_id).all()
    for row in existing:
        if _fold(row.name) == _fold(name):
            return row
    order = max((row.sort_order or 0 for row in existing), default=0) + 1
    section_id = f'{line.line_id}-S{order}'
    while db.query(LineSection).filter_by(section_id=section_id).first():
        order += 1
        section_id = f'{line.line_id}-S{order}'
    section = LineSection(section_id=section_id, line_id=line.line_id, name=name, sort_order=order)
    db.add(section)
    db.flush()
    return section


def import_equipment_catalog(db: Session, rows: list[dict] | None = None, update_existing: bool = True) -> dict:
    catalog = rows if rows is not None else load_catalog()
    created = updated = skipped = 0
    errors = []
    for index, row in enumerate(catalog, 1):
        try:
            equipment_id = normalize_equipment_code(row.get('equipment_id') or row.get('source_code'))
            if not equipment_id:
                raise ValueError('Missing equipment_id')
            plant = ensure_plant(db, row.get('plant_name') or '')
            line = ensure_line(db, plant, row.get('line_name') or '')
            section = ensure_section(db, line, row.get('section_name') or '')
            year = row.get('year')
            commissioning = date(int(year), 1, 1) if year else None
            status = _clean(row.get('status')) or 'Running'
            if status not in {'Running', 'Operational', 'Under Maintenance', 'Out of Service'}:
                status = 'Running'
            payload = {
                'name': _clean(row.get('name'))[:150] or equipment_id,
                'equipment_type': _clean(row.get('category'))[:100] or 'Equipment',
                'plant_id': plant.plant_id,
                'line_id': line.line_id,
                'section_id': section.section_id if section else None,
                'area': _clean(row.get('area'))[:100] or None,
                'manufacturer': None,
                'commissioning_date': commissioning,
                'model': _clean(row.get('category'))[:100] or None,
                'serial_number': _clean(row.get('serial_number'))[:100] or None,
                'criticality': 'Important',
                'status': status,
                'condition': _clean(row.get('condition'))[:50] or 'Good',
            }
            current = db.query(Equipment).filter_by(equipment_id=equipment_id).first()
            if current:
                if not update_existing:
                    skipped += 1
                    continue
                for key, value in payload.items():
                    setattr(current, key, value)
                updated += 1
            else:
                db.add(Equipment(equipment_id=equipment_id, **payload))
                created += 1
        except Exception as exc:
            errors.append({'row': index, 'equipment_id': row.get('equipment_id'), 'error': str(exc)})
    db.commit()
    return {
        'ok': not errors,
        'total': len(catalog),
        'created': created,
        'updated': updated,
        'skipped': skipped,
        'errors': errors[:50],
        'error_count': len(errors),
    }
