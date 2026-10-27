"""Import equipment rows from the Add Equipment catalog JSON / PDF form."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from datetime import date
from pathlib import Path

from sqlalchemy.exc import IntegrityError
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
    'Feed Mill',
    'الاعلاف',
    'فالعالا',  # reversed الاعلاف from pdftotext -raw
)
# English one-line form (preferred): code name category Feed Mill N line … year
EN_ROW_RE = re.compile(
    r'^(\d{3,8})\s+(.+?)\s+([A-Za-z]{3,8})\s+(Feed\s*Mill\s*[12])\s+'
    r'(Intake\s*\d+|Line\s*\d+|Line\d+|Line)(?:\s+(OTL))?\s+(.+)\s+(\d{4})$',
    re.IGNORECASE,
)
# Legacy Arabic two-line form from older PDFs.
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

# Canonical plant names are always English.
PLANT_MATCHERS = (
    (
        'Feed Mill 1',
        (
            'feed mill 1',
            'feedmill 1',
            'first feed',
            'الاعلاف الاولى',
            'الاعلاف الأولى',
            'اعلاف اولى',
            'اعلاف أولى',
            'فالعالا ىلوالا',
        ),
    ),
    (
        'Feed Mill 2',
        (
            'feed mill 2',
            'feedmill 2',
            'second feed',
            'الاعلاف الثانيه',
            'الاعلاف الثانية',
            'اعلاف ثانيه',
            'اعلاف ثانية',
            'فالعالا هيناثلا',
        ),
    ),
)

PLANT_DEFAULTS = {
    'Feed Mill 1': {'plant_id': 'FM01', 'order_code': 'FM1'},
    'Feed Mill 2': {'plant_id': 'FM02', 'order_code': 'FM2'},
}


def _clean(value) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _english_text(value: str) -> str:
    """Keep equipment fields in English (drop Arabic glyphs if present)."""
    text = _clean(value)
    text = ARABIC_RE.sub(' ', text)
    return _clean(text)


def _fold(value: str) -> str:
    text = _clean(value).casefold()
    text = text.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه')
    text = re.sub(r'\s+', ' ', text)
    return text


def normalize_plant_name(plant_name: str) -> str:
    """Always store plants as Feed Mill 1 / Feed Mill 2 (English)."""
    key = match_plant_key(plant_name)
    if key:
        return key
    folded = _fold(plant_name)
    if '2' in folded or 'ثان' in folded or 'second' in folded:
        return 'Feed Mill 2'
    if '1' in folded or 'اول' in folded or 'first' in folded:
        return 'Feed Mill 1'
    english = _english_text(plant_name)
    return english or 'Feed Mill 1'


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


def _row_dict(
    *,
    code: str,
    name: str,
    category: str,
    plant: str,
    line_name: str,
    section_name: str,
    area: str,
    year: int,
) -> dict:
    return {
        'equipment_id': code,
        'source_code': code,
        'name': _english_text(name) or code,
        'category': _english_text(category).upper() or 'Equipment',
        'plant_name': normalize_plant_name(plant),
        'line_name': _english_text(line_name),
        'section_name': _english_text(section_name),
        'area': _english_text(area),
        'year': year,
        'serial_number': None,
        'status': 'Running',
        'condition': 'Good',
    }


def parse_add_equipment_pdf_text(text: str) -> list[dict]:
    """Parse Add Equipment.pdf rows (English one-line form, with Arabic two-line fallback)."""
    lines = [line.strip() for line in (text or '').splitlines() if line.strip()]
    rows: list[dict] = []
    index = 0
    while index < len(lines):
        en = EN_ROW_RE.match(lines[index])
        if en:
            try:
                year = int(en.group(8))
            except ValueError:
                index += 1
                continue
            if year < 1990 or year > 2100:
                index += 1
                continue
            line_name = _clean(en.group(5))
            if en.group(6):
                section_name, area = 'OTL', _clean(en.group(7))
            else:
                section_name, area = _split_section_area(en.group(7))
            rows.append(_row_dict(
                code=en.group(1),
                name=en.group(2),
                category=en.group(3),
                plant=en.group(4),
                line_name=line_name,
                section_name=section_name,
                area=area,
                year=year,
            ))
            index += 1
            continue

        # Legacy Arabic two-line rows → still stored in English.
        if index >= len(lines) - 1:
            break
        match1 = LINE1_RE.match(lines[index])
        match2 = LINE2_RE.match(lines[index + 1]) if match1 else None
        if not match1 or not match2:
            index += 1
            continue
        plant = _clean(
            f'{_repair_plant_fragment(match1.group(4))} {_repair_plant_fragment(match2.group(1))}'
        )
        line_name = _clean(match2.group(2))
        if match2.group(3):
            section_name, area = 'OTL', _clean(match2.group(4))
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
        rows.append(_row_dict(
            code=match1.group(1),
            name=match1.group(2),
            category=match1.group(3),
            plant=plant,
            line_name=line_name,
            section_name=section_name,
            area=area,
            year=year,
        ))
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
    """Resolve plant; always persist English canonical name (Feed Mill 1/2)."""
    key = normalize_plant_name(plant_name)
    defaults = PLANT_DEFAULTS.get(key, {})
    order_code = defaults.get('order_code')
    default_plant_id = defaults.get('plant_id')
    plants = db.query(Plant).all()
    for plant in plants:
        existing_key = match_plant_key(plant.name or '')
        same_name = existing_key == key or _fold(plant.name or '') == _fold(key)
        same_id = bool(default_plant_id) and plant.plant_id == default_plant_id
        # Live DBs may use FM1 instead of FM01 — still the same Feed Mill.
        same_order = bool(order_code) and (
            _fold(plant.order_code or '') == _fold(order_code)
            or _fold(plant.plant_id or '') == _fold(order_code)
        )
        if same_name or same_id or same_order:
            if plant.name != key:
                plant.name = key
            return plant
    plant_id = default_plant_id or f'PLANT-{abs(hash(key)) % 10000:04d}'
    while db.query(Plant).filter_by(plant_id=plant_id).first():
        plant_id = f'{plant_id}X'
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
    seen: set[tuple[str, str, str]] = set()
    for index, row in enumerate(catalog, 1):
        nested = db.begin_nested()
        try:
            equipment_id = normalize_equipment_code(row.get('equipment_id') or row.get('source_code'))
            if not equipment_id:
                raise ValueError('Missing equipment_id')
            plant = ensure_plant(db, row.get('plant_name') or '')
            line = ensure_line(db, plant, row.get('line_name') or '')
            scope_key = (plant.plant_id, line.line_id, equipment_id)
            if scope_key in seen:
                nested.rollback()
                skipped += 1
                continue
            section = ensure_section(db, line, row.get('section_name') or '')
            year = row.get('year')
            commissioning = date(int(year), 1, 1) if year else None
            status = _clean(row.get('status')) or 'Running'
            if status not in {'Running', 'Operational', 'Under Maintenance', 'Out of Service'}:
                status = 'Running'
            payload = {
                'name': (_english_text(row.get('name'))[:150] or equipment_id),
                'equipment_type': (_english_text(row.get('category'))[:100] or 'Equipment'),
                'plant_id': plant.plant_id,
                'line_id': line.line_id,
                'section_id': section.section_id if section else None,
                'area': (_english_text(row.get('area'))[:100] or None),
                'manufacturer': None,
                'commissioning_date': commissioning,
                'model': (_english_text(row.get('category'))[:100] or None),
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
                seen.add(scope_key)
                if not update_existing:
                    nested.commit()
                    skipped += 1
                    continue
                for key, value in payload.items():
                    setattr(current, key, value)
                nested.commit()
                updated += 1
            else:
                db.add(Equipment(equipment_id=equipment_id, **payload))
                db.flush()
                nested.commit()
                seen.add(scope_key)
                created += 1
        except IntegrityError:
            nested.rollback()
            skipped += 1
        except Exception as exc:
            nested.rollback()
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
