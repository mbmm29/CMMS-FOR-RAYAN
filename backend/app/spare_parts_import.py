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
UNIT_LINE_RE = re.compile(r'^\d+\s+\S')
NAME_LINE_RE = re.compile(r'^0\s+')
STOCK_LINE_RE = re.compile(r'^\d+(\.\d+)?$')
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


def parse_mekanik_stock_text(text: str) -> list[dict]:
    """Parse أرصدة المواد rows: Part No. / name / final stock / unit."""
    lines = [line.strip() for line in (text or '').splitlines()]
    parts: list[dict] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not PART_NO_RE.fullmatch(line):
            index += 1
            continue
        part_no = line
        cursor = index + 1
        while cursor < len(lines) and not lines[cursor]:
            cursor += 1
        if cursor >= len(lines) or not UNIT_LINE_RE.match(lines[cursor]):
            index += 1
            continue
        unit_line = lines[cursor]
        unit = 'kg' if re.search(r'ﻛﻐﻢ|كغم|KG|kg', unit_line, re.IGNORECASE) else 'pcs'
        cursor += 1
        while cursor < len(lines) and not lines[cursor]:
            cursor += 1
        if cursor >= len(lines) or not NAME_LINE_RE.match(lines[cursor]):
            index += 1
            continue
        name = NAME_LINE_RE.sub('', lines[cursor], count=1).strip().lstrip('/').strip()
        cursor += 1
        while cursor < len(lines) and not lines[cursor]:
            cursor += 1
        if cursor >= len(lines) or not STOCK_LINE_RE.fullmatch(lines[cursor]):
            index += 1
            continue
        stock = float(lines[cursor])
        name_fixed = repair_bidi_name(name)
        name_fixed = re.sub(r'\s+', ' ', name_fixed).strip().lstrip('/').strip()
        name_fixed = name_fixed.replace('( ', '(').replace(' )', ')')
        if len(name_fixed) > 200:
            name_fixed = name_fixed[:200]
        if name_fixed:
            parts.append({
                'part_number': part_no,
                'name': name_fixed,
                'stock_qty': stock,
                'unit': unit,
            })
        index = cursor + 1

    # Keep last row per part number (latest balance in the report).
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


def import_spare_rows(
    db: Session,
    rows: list[dict],
    *,
    source: str = SOURCE_NOTE,
    update_existing: bool = True,
) -> dict:
    """Upsert Part No. / Part name / Stock, then link new/updated parts by Category."""
    existing = {
        (part.part_number or '').strip().lower(): part
        for part in db.query(SparePart).all()
    }
    seq = _next_part_seq(db)
    created = 0
    updated = 0
    skipped = 0
    touched: list[SparePart] = []

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
