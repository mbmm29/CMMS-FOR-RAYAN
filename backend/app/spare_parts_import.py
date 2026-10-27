"""Import mechanical warehouse spare parts from ميكانيك.pdf (أرصدة المواد form)."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from sqlalchemy.orm import Session

from .models import Equipment, SparePart, SparePartEquipment

CATALOG_PATH = Path(__file__).resolve().parent / 'data' / 'mekanik_spare_parts.json'
SOURCE_NOTE = 'ميكانيك.pdf'
ARABIC_RE = re.compile(
    r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+'
)
LATIN_TOKEN_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9./\-_*+%,:]*')
PART_NO_RE = re.compile(r'^\d{4,8}$')
UNIT_LINE_RE = re.compile(r'^\d+(?:[.,]\d+)?\s+\S')
# Leading qty on the name line: "0 / name", "1 (كاتم)…", "19.75 (كغم)…"
NAME_PREFIX_RE = re.compile(r'^(\d+(?:[.,]\d+)?)\s+(.+)$')
STOCK_LINE_RE = re.compile(r'^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$')
WAREHOUSE_LINE_RE = re.compile(
    r'مخزن|استخلاص|ﻥﺰﺨﻣ|ﺹﻼﺨﺘﺳﻻﺍ|الادوات|ﺕﺍﻭﺩﻻﺍ',
    re.IGNORECASE,
)
KG_UNIT_RE = re.compile(r'كغم|ﻛﻐﻢ|ﻢﻐﻛ|مغك|\bkg\b', re.IGNORECASE)
FORM_MARKERS = (
    'أرصدة المواد',
    'الرصيد النهائي',
    'رقم المادة',
    'اسم المادة',
    'ﺩﺍﻮﻤﻟﺍ ﺓﺪﺻﺭﺍ',  # reversed أرصدة المواد from pdftotext -raw
    'ﻲﺋﺎﻬﻨﻟﺍ ﺪﻴﺻﺮﻟﺍ',  # reversed الرصيد النهائي
    'ﺓﺩﺎﻤﻟﺍ ﻢﻗﺭ',  # reversed رقم المادة
)


def _clean(value) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def normalize_part_number(value) -> str:
    """Canonical warehouse Part No. / رقم المادة — uniqueness key for spare parts."""
    text = _clean(value)
    if not text:
        return ''
    # Drop spaces inside numeric warehouse codes (e.g. "12 345" → "12345").
    compact = re.sub(r'\s+', '', text)
    if compact.isdigit():
        return compact
    return text


def _reverse_chars(text: str) -> str:
    return text[::-1]


def repair_arabic_runs(text: str) -> str:
    return ARABIC_RE.sub(lambda match: _reverse_chars(match.group(0)), text or '')


def repair_bidi_name(text: str) -> str:
    """Undo RTL/visual order from pdftotext -raw on the warehouse PDF."""
    if not text:
        return text
    arabic = len(ARABIC_RE.findall(text))
    latin = len(re.findall(r'[A-Za-z]', text))
    if arabic >= latin:
        rev = _reverse_chars(text)
        return LATIN_TOKEN_RE.sub(lambda match: _reverse_chars(match.group(0)), rev)
    return repair_arabic_runs(text)


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


def _equipment_by_category(db: Session) -> dict[str, set[str]]:
    """Map Category (equipment_type / model) → equipment codes."""
    by_category: dict[str, set[str]] = {}
    for row in db.query(Equipment).all():
        code = (row.equipment_id or '').strip()
        if not code:
            continue
        for raw in (row.equipment_type, row.model):
            cat = _clean(raw).upper()
            if len(cat) < 3 or not re.fullmatch(r'[A-Z0-9]{3,12}', cat):
                continue
            by_category.setdefault(cat, set()).add(code)
    return by_category


def link_spare_parts_by_category(db: Session, commit: bool = True) -> dict:
    """Link spare parts whose name/number contains an equipment Category code.

    Example: part name \"Side Seal DFML-80146-810\" → all equipment with Category DFML.
    """
    by_category = _equipment_by_category(db)
    if not by_category:
        return {
            'categories': 0,
            'matched_parts': 0,
            'links_added': 0,
            'equipment_linked': 0,
        }

    categories = sorted(by_category.keys(), key=len, reverse=True)
    pattern = re.compile(
        r'(?<![A-Za-z0-9])(' + '|'.join(re.escape(cat) for cat in categories) + r')(?![A-Za-z0-9])',
        re.IGNORECASE,
    )
    existing_links = {
        (row.part_id, row.equipment_id)
        for row in db.query(SparePartEquipment).all()
    }
    matched_parts = 0
    links_added = 0
    equipment_hit: set[str] = set()

    for part in db.query(SparePart).all():
        text = f'{part.part_number or ""} {part.name or ""}'
        found = {match.group(1).upper() for match in pattern.finditer(text)}
        if not found:
            continue
        matched_parts += 1
        for cat in found:
            for equipment_id in by_category.get(cat, ()):
                key = (part.part_id, equipment_id)
                if key in existing_links:
                    continue
                db.add(SparePartEquipment(part_id=part.part_id, equipment_id=equipment_id))
                existing_links.add(key)
                links_added += 1
                equipment_hit.add(equipment_id)

    if commit:
        db.commit()
    else:
        db.flush()
    return {
        'categories': len(by_category),
        'matched_parts': matched_parts,
        'links_added': links_added,
        'equipment_linked': len(equipment_hit),
    }


def extract_pdf_raw_text(pdf_bytes: bytes) -> str:
    """Extract text in the same order as `pdftotext -raw` (required for this form)."""
    if not pdf_bytes:
        raise ValueError('Empty PDF file')
    pdftotext = shutil.which('pdftotext')
    if not pdftotext:
        raise ValueError('PDF reader is not installed on the server (pdftotext).')
    with tempfile.TemporaryDirectory(prefix='mekanik-') as tmp:
        pdf_path = Path(tmp) / 'stock.pdf'
        txt_path = Path(tmp) / 'stock.txt'
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


def looks_like_mekanik_stock_form(text: str) -> bool:
    sample = text[:8000]
    if any(marker in sample for marker in FORM_MARKERS):
        return True
    # Fallback: enough part-number blocks even if header glyphs differ.
    hits = len(re.findall(r'(?m)^\d{4,8}\s*$', text))
    return hits >= 20


def _parse_stock_number(value: str) -> float | None:
    """Parse final stock; accept thousands separators (1,075 → 1075)."""
    text = _clean(value)
    if not text or not STOCK_LINE_RE.fullmatch(text):
        return None
    try:
        return float(text.replace(',', ''))
    except ValueError:
        return None


def _next_nonempty(lines: list[str], start: int) -> int:
    cursor = start
    while cursor < len(lines) and not lines[cursor]:
        cursor += 1
    return cursor


def _is_part_header(lines: list[str], index: int) -> bool:
    """True when this line is رقم المادة followed by a unit line (قطعة/كغم)."""
    if index >= len(lines) or not PART_NO_RE.fullmatch(lines[index]):
        return False
    nxt = _next_nonempty(lines, index + 1)
    return nxt < len(lines) and bool(UNIT_LINE_RE.match(lines[nxt]))


def _fix_name(name_lines: list[str]) -> str:
    lines = list(name_lines)
    if len(lines) > 1 and _parse_stock_number(lines[0]) is not None:
        # Bare leading qty on its own line (0 / 1 / 5) before the real name.
        lines = lines[1:]
    if not lines:
        return ''
    first = lines[0]
    match = NAME_PREFIX_RE.match(first)
    if match:
        # "0 / name", "1 (كاتم)…", "19.75 (كغم)…" → keep the name side.
        lines[0] = match.group(2).strip()
    name = ' '.join(part for part in lines if part).strip().lstrip('/').strip()
    name = repair_bidi_name(name)
    name = re.sub(r'\s+', ' ', name).strip().lstrip('/').strip()
    name = name.replace('( ', '(').replace(' )', ')')
    if len(name) > 200:
        name = name[:200]
    return name


def _is_location_code(value: str) -> bool:
    """Shelf / column codes such as R174, C12, A1, H28, S1."""
    text = _clean(value)
    if not text or _parse_stock_number(text) is not None:
        return False
    return bool(re.fullmatch(r'[A-Za-z][A-Za-z0-9\-]{0,11}', text))


def parse_mekanik_stock_text(text: str) -> list[dict]:
    """Parse أرصدة المواد: رقم المادة / name / الرصيد النهائي / unit.

    Text order from pdftotext -raw:
      part no → unit → name → [optional nums] → مخزن → رف/عمود → columns → الرصيد النهائي
    Stock is the last numeric field before the next material (column الرصيد النهائي).
    """
    lines = [line.strip() for line in (text or '').splitlines()]
    parts: list[dict] = []
    index = 0
    while index < len(lines):
        if not _is_part_header(lines, index):
            index += 1
            continue
        part_no = lines[index]
        cursor = _next_nonempty(lines, index + 1)
        unit_line = lines[cursor]
        unit = 'kg' if KG_UNIT_RE.search(unit_line) else 'pcs'
        cursor += 1

        name_lines: list[str] = []
        pre_warehouse_numbers: list[str] = []
        saw_warehouse = False
        after_numbers: list[float] = []

        while cursor < len(lines):
            raw = lines[cursor]
            if not raw:
                cursor += 1
                continue
            if _is_part_header(lines, cursor) and (name_lines or saw_warehouse or after_numbers):
                break
            if WAREHOUSE_LINE_RE.search(raw):
                saw_warehouse = True
                cursor += 1
                continue
            if not saw_warehouse:
                stock_value = _parse_stock_number(raw)
                if stock_value is not None and name_lines:
                    pre_warehouse_numbers.append(raw)
                else:
                    if pre_warehouse_numbers:
                        name_lines.extend(pre_warehouse_numbers)
                        pre_warehouse_numbers = []
                    name_lines.append(raw)
                cursor += 1
                continue

            if _is_location_code(raw):
                cursor += 1
                continue
            stock_value = _parse_stock_number(raw)
            if stock_value is not None:
                after_numbers.append(stock_value)
                cursor += 1
                continue
            break

        if after_numbers:
            stock = after_numbers[-1]
        elif pre_warehouse_numbers:
            stock = _parse_stock_number(pre_warehouse_numbers[-1])
        else:
            stock = None
        name_fixed = _format_name(name_lines)
        if name_fixed and stock is not None:
            parts.append({
                'part_number': part_no,
                'name': name_fixed,
                'stock_qty': stock,
                'unit': unit,
            })
        index = cursor

    unique: dict[str, dict] = {}
    for row in parts:
        unique[row['part_number']] = row
    return list(unique.values())

def parse_mekanik_pdf(pdf_bytes: bytes) -> list[dict]:
    text = extract_pdf_raw_text(pdf_bytes)
    if not looks_like_mekanik_stock_form(text):
        raise ValueError(
            'This PDF is not the mechanical stock form (أرصدة المواد). '
            'Upload a file with the same layout as ميكانيك.pdf.'
        )
    rows = parse_mekanik_stock_text(text)
    if len(rows) < 10:
        raise ValueError(
            'Could not read spare-part rows from this PDF. '
            'Use the same form as ميكانيك.pdf (Part No., name, final stock).'
        )
    return rows


def dedupe_spare_parts_by_part_number(db: Session, commit: bool = True) -> dict:
    """Keep one row per رقم المادة / Part No.; merge equipment links then delete duplicates."""
    groups: dict[str, list[SparePart]] = {}
    for part in db.query(SparePart).order_by(SparePart.part_id).all():
        key = normalize_part_number(part.part_number).lower()
        if not key:
            continue
        groups.setdefault(key, []).append(part)

    removed = 0
    merged_links = 0
    for key, parts in groups.items():
        keeper = parts[0]
        canonical = normalize_part_number(keeper.part_number)[:100]
        if keeper.part_number != canonical:
            keeper.part_number = canonical
        if len(parts) == 1:
            continue
        existing_links = {
            row.equipment_id
            for row in db.query(SparePartEquipment).filter_by(part_id=keeper.part_id).all()
        }
        for duplicate in parts[1:]:
            for row in db.query(SparePartEquipment).filter_by(part_id=duplicate.part_id).all():
                if row.equipment_id not in existing_links:
                    db.add(SparePartEquipment(part_id=keeper.part_id, equipment_id=row.equipment_id))
                    existing_links.add(row.equipment_id)
                    merged_links += 1
            db.query(SparePartEquipment).filter_by(part_id=duplicate.part_id).delete(synchronize_session=False)
            if keeper.critical_qty is None and duplicate.critical_qty is not None:
                keeper.critical_qty = duplicate.critical_qty
            db.delete(duplicate)
            removed += 1

    if commit:
        db.commit()
    else:
        db.flush()
    return {'duplicate_parts_removed': removed, 'links_merged': merged_links}


def import_spare_rows(
    db: Session,
    rows: list[dict],
    *,
    source: str = SOURCE_NOTE,
    update_existing: bool = True,
) -> dict:
    """Match only on Part No. / رقم المادة: update stock if present, add only when the number is new."""
    dedupe = dedupe_spare_parts_by_part_number(db, commit=False)
    existing: dict[str, SparePart] = {}
    for part in db.query(SparePart).all():
        key = normalize_part_number(part.part_number).lower()
        if key and key not in existing:
            existing[key] = part
            canonical = normalize_part_number(part.part_number)[:100]
            if part.part_number != canonical:
                part.part_number = canonical

    seq = _next_part_seq(db)
    created = 0
    updated = 0
    skipped = 0
    skipped_existing = 0
    touched: list[SparePart] = []

    for row in rows:
        number = normalize_part_number(row.get('part_number'))
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
            # رقم المادة موجود مسبقاً → لا إضافة جديدة، فقط تحديث الرصيد/الاسم.
            if not update_existing:
                skipped += 1
                skipped_existing += 1
                continue
            part.part_number = number[:100]
            part.name = name
            part.stock_qty = stock_qty
            part.unit = unit
            part.notes = source[:200] if source else part.notes
            updated += 1
            touched.append(part)
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
            notes=(source or SOURCE_NOTE)[:200],
        )
        db.add(part)
        existing[key] = part
        created += 1
        touched.append(part)

    db.flush()
    links = link_spare_parts_by_category(db, commit=False)
    db.commit()
    return {
        'source': source or SOURCE_NOTE,
        'rows': len(rows),
        'created': created,
        'updated': updated,
        'skipped': skipped,
        'skipped_existing': skipped_existing,
        'dedupe': dedupe,
        'category_links': links,
        'touched_ids': [part.part_id for part in touched if part.part_id],
    }


def import_mekanik_spare_parts(db: Session, update_existing: bool = True) -> dict:
    """Upsert Part No. / Part name / Stock from the bundled ميكانيك.pdf extract."""
    return import_spare_rows(
        db,
        load_catalog(),
        source=SOURCE_NOTE,
        update_existing=update_existing,
    )


def import_mekanik_pdf_bytes(db: Session, pdf_bytes: bytes, filename: str | None = None) -> dict:
    """Parse an uploaded أرصدة المواد PDF and refresh spare parts + Category links."""
    rows = parse_mekanik_pdf(pdf_bytes)
    source = _clean(filename) or SOURCE_NOTE
    if not source.lower().endswith('.pdf'):
        source = f'{source}.pdf' if source else SOURCE_NOTE
    result = import_spare_rows(db, rows, source=source[:200], update_existing=True)
    result['filename'] = source
    return result
