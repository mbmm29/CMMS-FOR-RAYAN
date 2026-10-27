"""Import equipment rows from the Add Equipment catalog JSON / PDF form."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from datetime import date
from pathlib import Path

from sqlalchemy.orm import Session

from .models import Equipment, LineSection, Plant, PlantLine
from .equipment_code_normalize import normalize_equipment_code

CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'add_equipment_catalog.json'
SOURCE_PDF_NOTE = 'Add Equipment.pdf'
ARABIC_RE = re.compile(
    r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+'
)
FORM_MARKERS = (
    'Equipment code',
    'Category',
    'Plant',
    'الاعلاف',
    'فالعالا',  # reversed الاعلاف from pdftotext -raw
)
LINE1_RE = re.compile(r'^(\d{3,8})\s+(.+?)\s+([A-Za-z]{3,8})\s+(\S+)$')
LINE2_RE = re.compile(
    r'^(\S+)\s+(Intake\s*\d+|Line\s*\d+|Line\d+|Line)(?:\s+(OTL))?\s+(.+)\s+(\d{4})$',
    re.IGNORECASE,
)
KNOWN_SECTIONS = {
    'ppr': 'PPR',
    'mix': 'Mix',
    'bag': 'Bagging',
    'baging': 'Bagging',
    'bagging': 'Bagging',
    'outload': 'Outload',
    'otl': 'OTL',
}

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


def _reverse_chars(text: str) -> str:
    return text[::-1]


def _repair_plant_fragment(text: str) -> str:
    """Undo RTL visual order for Arabic plant name fragments from pdftotext -raw."""
    return ARABIC_RE.sub(lambda match: _reverse_chars(match.group(0)), text or '')


def _split_section_area(rest: str) -> tuple[str, str]:
    text = _clean(rest)
    if not text:
        return '', ''
    tokens = text.split()
    if not tokens:
        return '', ''
    first_key = tokens[0].casefold()
    if first_key in KNOWN_SECTIONS:
        section = KNOWN_SECTIONS[first_key]
        area = _clean(' '.join(tokens[1:]))
        return section, area
    return '', text


def extract_equipment_pdf_raw_text(pdf_bytes: bytes) -> str:
    if not pdf_bytes:
        raise ValueError('Empty PDF file')
    pdftotext = shutil.which('pdftotext')
    if not pdftotext:
        raise ValueError('PDF reader is not installed on the server (pdftotext).')
    with tempfile.TemporaryDirectory(prefix='add-equipment-') as tmp:
        pdf_path = Path(tmp) / 'equipment.pdf'
        txt_path = Path(tmp) / 'equipment.txt'
        pdf_path.write_bytes(pdf_bytes)
        result = subprocess.run(
            [pdftotext, '-raw', '-enc', 'UTF-8', str(pdf_path), str(txt_path)],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or '').strip() or 'pdftotext failed'
            raise ValueError(detail)
        return txt_path.read_text(encoding='utf-8', errors='replace')


def looks_like_add_equipment_form(text: str) -> bool:
    sample = text[:5000]
    if 'Equipment code' in sample and 'Category' in sample:
        return True
    return any(marker in sample for marker in FORM_MARKERS) and len(re.findall(r'(?m)^\d{3,8}\s+', text)) >= 10


def parse_add_equipment_pdf_text(text: str) -> list[dict]:
    """Parse Add Equipment.pdf rows (same columns as the Excel/PDF catalog form)."""
    lines = [line.strip() for line in (text or '').splitlines() if line.strip()]
    rows: list[dict] = []
    index = 0
    while index < len(lines) - 1:
        first = lines[index]
        second = lines[index + 1]
        match1 = LINE1_RE.match(first)
        match2 = LINE2_RE.match(second) if match1 else None
        if not match1 or not match2:
            index += 1
            continue
        code = match1.group(1)
        name = _clean(match1.group(2))
        category = _clean(match1.group(3)).upper()
        plant = _clean(
            f'{_repair_plant_fragment(match1.group(4))} {_repair_plant_fragment(match2.group(1))}'
        )
        line_name = _clean(match2.group(2))
        if match2.group(3):
            # "Line OTL" → line Line, section OTL
            section_name = 'OTL'
            area = _clean(match2.group(4))
        else:
            section_name, area = _split_section_area(match2.group(4))
        try:
            year = int(match2.group(5))
        except ValueError:
            index += 1
            continue
        if year < 1990 or year > 2100:
            index += 1
            continue
        rows.append({
            'equipment_id': code,
            'source_code': code,
            'name': name,
            'category': category,
            'plant_name': plant,
            'line_name': line_name,
            'section_name': section_name,
            'area': area,
            'year': year,
            'serial_number': None,
            'status': 'Running',
            'condition': 'Good',
        })
        index += 2
    return rows


def parse_add_equipment_pdf(pdf_bytes: bytes) -> list[dict]:
    text = extract_equipment_pdf_raw_text(pdf_bytes)
    if not looks_like_add_equipment_form(text):
        raise ValueError(
            'This PDF is not the Add Equipment form. '
            'Upload a file with the same layout as Add Equipment.pdf.'
        )
    rows = parse_add_equipment_pdf_text(text)
    if len(rows) < 5:
        raise ValueError(
            'Could not read equipment rows from this PDF. '
            'Use the same form as Add Equipment.pdf.'
        )
    return rows


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
    """Upsert equipment. Same Equipment code may exist on another plant/line; duplicate on same plant+line is skipped/updated."""
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
            # Unique within plant + line only (same code allowed on another line/plant).
            current = db.query(Equipment).filter_by(
                equipment_id=equipment_id,
                plant_id=plant.plant_id,
                line_id=line.line_id,
            ).first()
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


def import_equipment_pdf_bytes(
    db: Session,
    pdf_bytes: bytes,
    filename: str | None = None,
    update_existing: bool = False,
) -> dict:
    """Import Add Equipment.pdf: add new machines; skip when same code already exists on that plant+line."""
    rows = parse_add_equipment_pdf(pdf_bytes)
    result = import_equipment_catalog(db, rows=rows, update_existing=update_existing)
    result['filename'] = _clean(filename) or SOURCE_PDF_NOTE
    result['source'] = SOURCE_PDF_NOTE
    result['rows'] = len(rows)
    return result
