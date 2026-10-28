"""Import equipment rows from the Add Equipment catalog JSON / Excel / PDF form."""
from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Equipment, LineSection, Plant, PlantLine
from .equipment_code_normalize import normalize_equipment_code

CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'add_equipment_catalog.json'
SOURCE_XLSX_NOTE = 'Add Equipment.xlsx'
SOURCE_PDF_NOTE = 'Add Equipment.pdf'
_XLSX_NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
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


def _reject_item(
    *,
    equipment_id: str = '',
    name: str = '',
    plant_name: str = '',
    line_name: str = '',
    reason: str,
    kind: str = 'error',
    row: int | None = None,
    raw: str = '',
) -> dict:
    return {
        'equipment_id': _clean(equipment_id),
        'name': _english_text(name) or _clean(name),
        'plant_name': _clean(plant_name),
        'line_name': _clean(line_name),
        'reason': _clean(reason),
        'kind': kind,
        'row': row,
        'raw': _clean(raw)[:180],
    }


def _guess_code_name(line: str) -> tuple[str, str]:
    match = re.match(r'^(\d{3,8})\s+(.+?)(?:\s+[A-Za-z]{3,8}\b|$)', _clean(line))
    if not match:
        digits = re.match(r'^(\d{3,8})\b', _clean(line))
        return (digits.group(1) if digits else ''), ''
    return match.group(1), _clean(match.group(2))


def parse_add_equipment_pdf_text(text: str) -> tuple[list[dict], list[dict]]:
    """Parse Add Equipment.pdf rows. Returns (valid_rows, parse_rejects)."""
    lines = [line.strip() for line in (text or '').splitlines() if line.strip()]
    rows: list[dict] = []
    rejects: list[dict] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        en = EN_ROW_RE.match(line)
        if en:
            try:
                year = int(en.group(8))
            except ValueError:
                code, name = en.group(1), en.group(2)
                rejects.append(_reject_item(
                    equipment_id=code,
                    name=name,
                    plant_name=en.group(4),
                    line_name=en.group(5),
                    reason='Invalid year on this row',
                    kind='parse',
                    row=index + 1,
                    raw=line,
                ))
                index += 1
                continue
            if year < 1990 or year > 2100:
                rejects.append(_reject_item(
                    equipment_id=en.group(1),
                    name=en.group(2),
                    plant_name=en.group(4),
                    line_name=en.group(5),
                    reason=f'Year {year} is out of range',
                    kind='parse',
                    row=index + 1,
                    raw=line,
                ))
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
            if re.match(r'^\d{3,8}\b', line) and 'Equipment code' not in line:
                code, name = _guess_code_name(line)
                rejects.append(_reject_item(
                    equipment_id=code,
                    name=name,
                    reason='Incomplete row (missing plant, line, or year)',
                    kind='parse',
                    row=index + 1,
                    raw=line,
                ))
            break
        match1 = LINE1_RE.match(lines[index])
        match2 = LINE2_RE.match(lines[index + 1]) if match1 else None
        if not match1 or not match2:
            if re.match(r'^\d{3,8}\b', line) and 'Equipment code' not in line and not EN_ROW_RE.match(line):
                # Likely a broken English row (truncated PDF line).
                code, name = _guess_code_name(line)
                if 'Feed Mill' in line or match1:
                    rejects.append(_reject_item(
                        equipment_id=code or (match1.group(1) if match1 else ''),
                        name=name or (match1.group(2) if match1 else ''),
                        plant_name=match1.group(4) if match1 else '',
                        reason='Incomplete or unreadable row in the PDF',
                        kind='parse',
                        row=index + 1,
                        raw=line,
                    ))
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
            rejects.append(_reject_item(
                equipment_id=match1.group(1),
                name=match1.group(2),
                plant_name=plant,
                line_name=line_name,
                reason='Invalid year on this row',
                kind='parse',
                row=index + 1,
                raw=f'{lines[index]} | {lines[index + 1]}',
            ))
            index += 1
            continue
        if year < 1990 or year > 2100:
            rejects.append(_reject_item(
                equipment_id=match1.group(1),
                name=match1.group(2),
                plant_name=plant,
                line_name=line_name,
                reason=f'Year {year} is out of range',
                kind='parse',
                row=index + 1,
                raw=f'{lines[index]} | {lines[index + 1]}',
            ))
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
    return rows, rejects


def parse_add_equipment_pdf(pdf_bytes: bytes) -> tuple[list[dict], list[dict]]:
    text = extract_equipment_pdf_raw_text(pdf_bytes)
    if not looks_like_add_equipment_form(text):
        raise ValueError(
            'This PDF is not the Add Equipment form. '
            'Upload a file with the same layout as Add Equipment.pdf.'
        )
    rows, rejects = parse_add_equipment_pdf_text(text)
    if len(rows) < 5:
        raise ValueError(
            'Could not read equipment rows from this PDF. '
            'Use the same form as Add Equipment.pdf.'
        )
    return rows, rejects


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


def import_equipment_catalog(
    db: Session,
    rows: list[dict] | None = None,
    update_existing: bool = True,
    parse_rejects: list[dict] | None = None,
) -> dict:
    """Upsert equipment. Valid rows are saved; failed/skipped rows are listed with reasons."""
    catalog = rows if rows is not None else load_catalog()
    created = updated = skipped = 0
    rejected: list[dict] = list(parse_rejects or [])
    errors: list[dict] = []
    seen: set[tuple[str, str, str]] = set()

    def note_reject(*, equipment_id='', name='', plant_name='', line_name='', reason='', kind='error', row=None):
        item = _reject_item(
            equipment_id=equipment_id,
            name=name,
            plant_name=plant_name,
            line_name=line_name,
            reason=reason,
            kind=kind,
            row=row,
        )
        rejected.append(item)
        if kind == 'error':
            errors.append({
                'row': row,
                'equipment_id': item['equipment_id'],
                'name': item['name'],
                'error': reason,
            })

    for index, row in enumerate(catalog, 1):
        nested = db.begin_nested()
        name = _english_text(row.get('name')) or _clean(row.get('name'))
        plant_label = _clean(row.get('plant_name'))
        line_label = _clean(row.get('line_name'))
        try:
            equipment_id = normalize_equipment_code(row.get('equipment_id') or row.get('source_code'))
            if not equipment_id:
                nested.rollback()
                note_reject(
                    name=name,
                    plant_name=plant_label,
                    line_name=line_label,
                    reason='Missing equipment code',
                    kind='error',
                    row=index,
                )
                continue
            plant = ensure_plant(db, plant_label or '')
            try:
                line = ensure_line(db, plant, line_label or '')
            except ValueError as exc:
                nested.rollback()
                note_reject(
                    equipment_id=equipment_id,
                    name=name,
                    plant_name=plant_label or plant.name,
                    line_name=line_label,
                    reason=str(exc) or 'Unrecognized line',
                    kind='error',
                    row=index,
                )
                continue
            scope_key = (plant.plant_id, line.line_id, equipment_id)
            if scope_key in seen:
                nested.rollback()
                skipped += 1
                note_reject(
                    equipment_id=equipment_id,
                    name=name,
                    plant_name=plant.name,
                    line_name=line.name,
                    reason='Duplicate row in the same file (same code on this plant and line)',
                    kind='duplicate',
                    row=index,
                )
                continue
            section = ensure_section(db, line, row.get('section_name') or '')
            year = row.get('year')
            commissioning = date(int(year), 1, 1) if year else None
            status = _clean(row.get('status')) or 'Running'
            if status not in {'Running', 'Operational', 'Under Maintenance', 'Out of Service'}:
                status = 'Running'
            payload = {
                'name': (name[:150] or equipment_id),
                'equipment_type': (_english_text(row.get('category'))[:100] or 'Equipment'),
                'plant_id': plant.plant_id,
                'line_id': line.line_id,
                'section_id': section.section_id if section else None,
                'area': (_english_text(row.get('area'))[:100] or None),
                'manufacturer': (_english_text(row.get('manufacturer'))[:100] or None),
                'commissioning_date': commissioning,
                'model': (_english_text(row.get('category'))[:100] or None),
                'serial_number': _clean(row.get('serial_number'))[:100] or None,
                'criticality': 'Important',
                'status': status,
                'condition': _clean(row.get('condition'))[:50] or 'Good',
            }
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
                    note_reject(
                        equipment_id=equipment_id,
                        name=name or current.name,
                        plant_name=plant.name,
                        line_name=line.name,
                        reason='Already exists on this plant and line — not inserted again',
                        kind='duplicate',
                        row=index,
                    )
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
            note_reject(
                equipment_id=normalize_equipment_code(row.get('equipment_id') or row.get('source_code')),
                name=name,
                plant_name=plant_label,
                line_name=line_label,
                reason='Already exists on this plant and line — not inserted again',
                kind='duplicate',
                row=index,
            )
        except Exception as exc:
            nested.rollback()
            note_reject(
                equipment_id=normalize_equipment_code(row.get('equipment_id') or row.get('source_code')),
                name=name,
                plant_name=plant_label,
                line_name=line_label,
                reason=str(exc).strip() or 'Could not save this equipment row',
                kind='error',
                row=index,
            )
    db.commit()
    hard_errors = [item for item in rejected if item.get('kind') in {'error', 'parse'}]
    return {
        'ok': not hard_errors,
        'total': len(catalog),
        'created': created,
        'updated': updated,
        'skipped': skipped,
        'rejected': rejected[:200],
        'rejected_count': len(rejected),
        'errors': errors[:50],
        'error_count': len(hard_errors),
    }


def _xlsx_col_index(ref: str) -> int:
    letters = ''.join(ch for ch in (ref or '') if ch.isalpha()).upper()
    number = 0
    for ch in letters:
        number = number * 26 + (ord(ch) - 64)
    return number


def _xlsx_cell_text(cell, shared: list[str]) -> str:
    kind = cell.attrib.get('t')
    if kind == 'inlineStr':
        return ''.join(node.text or '' for node in cell.iter(f'{_XLSX_NS}t')).strip()
    if kind == 's':
        value = cell.findtext(f'{_XLSX_NS}v')
        try:
            return str(shared[int(value)]).strip()
        except (TypeError, ValueError, IndexError):
            return ''
    value = cell.findtext(f'{_XLSX_NS}v')
    text = (value or '').strip()
    if not text:
        return ''
    # Excel stores integers as 1062.0 sometimes.
    if re.fullmatch(r'\d+\.0+', text):
        return text.split('.', 1)[0]
    return text


def read_xlsx_rows(raw: bytes) -> list[dict[int, str]]:
    """Return sparse column→text maps for each non-empty worksheet row (1-based columns)."""
    if not raw:
        raise ValueError('Empty Excel file')
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = set(archive.namelist())
            shared: list[str] = []
            if 'xl/sharedStrings.xml' in names:
                root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
                for item in root.findall(f'{_XLSX_NS}si'):
                    shared.append(''.join(node.text or '' for node in item.iter(f'{_XLSX_NS}t')).strip())
            sheet_name = next(
                (name for name in names if name.startswith('xl/worksheets/sheet') and name.endswith('.xml')),
                None,
            )
            if not sheet_name:
                raise ValueError('Excel sheet not found')
            sheet = ET.fromstring(archive.read(sheet_name))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Could not read the Excel file.') from exc

    rows: list[dict[int, str]] = []
    for row in sheet.findall(f'{_XLSX_NS}sheetData/{_XLSX_NS}row'):
        values: dict[int, str] = {}
        for cell in row.findall(f'{_XLSX_NS}c'):
            col = _xlsx_col_index(cell.attrib.get('r', ''))
            if not col:
                continue
            text = _xlsx_cell_text(cell, shared)
            if text:
                values[col] = text
        if values:
            rows.append(values)
    return rows


def _header_key(text: str) -> str:
    folded = _fold(text).replace('_', ' ')
    folded = re.sub(r'[^a-z0-9\u0600-\u06ff ]+', ' ', folded)
    folded = re.sub(r'\s+', ' ', folded).strip()
    aliases = {
        'equipment code': 'code',
        'equipment id': 'code',
        'code': 'code',
        'name': 'name',
        'equipment name': 'name',
        'category': 'category',
        'type': 'category',
        'plant': 'plant',
        'line': 'line',
        'line number': 'line',
        'section': 'section',
        'area': 'area',
        'manufacturer': 'manufacturer',
        'serial number': 'serial',
        'serial': 'serial',
        'status': 'status',
        'condition': 'condition',
        'year': 'year',
        'commissioning': 'year',
        'commissioning year': 'year',
    }
    return aliases.get(folded, folded)


def _as_year(value: str) -> int | None:
    text = _clean(value)
    if re.fullmatch(r'\d{4}', text):
        year = int(text)
        if 1990 <= year <= 2100:
            return year
    return None


def parse_add_equipment_xlsx(raw: bytes) -> tuple[list[dict], list[dict]]:
    """Parse Add Equipment.xlsx by column headers (stable when cell widths change)."""
    matrix = read_xlsx_rows(raw)
    if len(matrix) < 2:
        raise ValueError(
            'Could not read equipment rows from this Excel file. '
            'Use the same form as Add Equipment.xlsx.'
        )

    header_map: dict[str, int] = {}
    for col, text in matrix[0].items():
        key = _header_key(text)
        if key and key not in header_map:
            header_map[key] = col

    required = ('code', 'name', 'plant', 'line')
    if not all(key in header_map for key in required):
        raise ValueError(
            'This Excel file is not the Add Equipment form. '
            'Need columns: Equipment code, Name, Plant, Line.'
        )

    def cell(row: dict[int, str], key: str) -> str:
        col = header_map.get(key)
        if not col:
            return ''
        return _clean(row.get(col) or '')

    rows: list[dict] = []
    rejects: list[dict] = []
    for index, raw_row in enumerate(matrix[1:], start=2):
        code = cell(raw_row, 'code')
        name = cell(raw_row, 'name')
        category = cell(raw_row, 'category')
        plant = cell(raw_row, 'plant')
        line_name = cell(raw_row, 'line')
        section_name = cell(raw_row, 'section')
        area = cell(raw_row, 'area')
        manufacturer = cell(raw_row, 'manufacturer')
        serial = cell(raw_row, 'serial')
        status = cell(raw_row, 'status') or 'Running'
        condition = cell(raw_row, 'condition') or 'Good'
        year = _as_year(cell(raw_row, 'year'))
        # This workbook stores Year under the Manufacturer header.
        if year is None:
            year = _as_year(manufacturer)
            if year is not None:
                manufacturer = ''
        if not code and not name and not plant:
            continue
        if not code or not name or not plant or not line_name:
            rejects.append(_reject_item(
                equipment_id=code,
                name=name,
                plant_name=plant,
                line_name=line_name,
                reason='Incomplete Excel row (need code, name, plant, and line)',
                kind='parse',
                row=index,
            ))
            continue
        if year is None:
            rejects.append(_reject_item(
                equipment_id=code,
                name=name,
                plant_name=plant,
                line_name=line_name,
                reason='Missing or invalid year on this Excel row',
                kind='parse',
                row=index,
            ))
            continue
        if section_name.casefold() == 'otl' and not area:
            area = ''
        item = _row_dict(
            code=code,
            name=name,
            category=category or 'Equipment',
            plant=plant,
            line_name=line_name,
            section_name=section_name,
            area=area,
            year=year,
        )
        item['serial_number'] = serial or None
        item['status'] = status if status in {'Running', 'Operational', 'Under Maintenance', 'Out of Service'} else 'Running'
        item['condition'] = condition or 'Good'
        if manufacturer:
            item['manufacturer'] = _english_text(manufacturer)[:100]
        rows.append(item)

    if len(rows) < 5:
        raise ValueError(
            'Could not read equipment rows from this Excel file. '
            'Use the same form as Add Equipment.xlsx.'
        )
    return rows, rejects


def import_equipment_pdf_bytes(
    db: Session,
    pdf_bytes: bytes,
    filename: str | None = None,
    update_existing: bool = False,
) -> dict:
    """Import Add Equipment.pdf: add valid rows; report code/name/reason for rows not inserted."""
    rows, parse_rejects = parse_add_equipment_pdf(pdf_bytes)
    result = import_equipment_catalog(
        db,
        rows=rows,
        update_existing=update_existing,
        parse_rejects=parse_rejects,
    )
    result['filename'] = _clean(filename) or SOURCE_PDF_NOTE
    result['source'] = SOURCE_PDF_NOTE
    result['rows'] = len(rows)
    result['parse_rejects'] = len(parse_rejects)
    return result


def import_equipment_xlsx_bytes(
    db: Session,
    xlsx_bytes: bytes,
    filename: str | None = None,
    update_existing: bool = False,
) -> dict:
    """Import Add Equipment.xlsx: preferred source (stable columns, ignores cell widths)."""
    rows, parse_rejects = parse_add_equipment_xlsx(xlsx_bytes)
    result = import_equipment_catalog(
        db,
        rows=rows,
        update_existing=update_existing,
        parse_rejects=parse_rejects,
    )
    result['filename'] = _clean(filename) or SOURCE_XLSX_NOTE
    result['source'] = SOURCE_XLSX_NOTE
    result['rows'] = len(rows)
    result['parse_rejects'] = len(parse_rejects)
    return result


def import_equipment_file_bytes(
    db: Session,
    raw: bytes,
    filename: str | None = None,
    update_existing: bool = False,
) -> dict:
    """Import Add Equipment.xlsx (preferred) or legacy Add Equipment.pdf."""
    name = _clean(filename).casefold()
    if name.endswith('.xlsx'):
        return import_equipment_xlsx_bytes(db, raw, filename=filename, update_existing=update_existing)
    if name.endswith('.pdf'):
        return import_equipment_pdf_bytes(db, raw, filename=filename, update_existing=update_existing)
    raise ValueError('Upload an Excel (.xlsx) file in the same form as Add Equipment.xlsx.')
