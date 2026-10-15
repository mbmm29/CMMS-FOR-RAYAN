"""Approved CMMS KPI equations.

The calculations follow the approved SMRP-adapted definitions and use the
records the project actually stores: PM plans, work orders, daily reports,
machine records, and component history.
"""
import math
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from .models import (
    Component, DailyReport, DailyReportItem, Equipment, KpiTarget, MachineRecord,
    Plant, PlantLine, PMPlan, WorkOrder, WorkOrderAssignment,
)

FAILURE_TYPES = {'Corrective', 'Emergency'}
CLOSED = {'Closed', 'Completed'}
HOUR_TYPES = ('Preventive', 'Corrective', 'Routine', 'Inspection', 'Emergency', 'Lubrication')
RECEIVED_REPORTS = {'Submitted', 'Approved', 'Returned'}
REPORT_SHIFT_HOURS = 8
HIGHER_IS_BETTER = {
    'availability', 'mtbf', 'pm_compliance', 'planned_pm', 'preventive_pct',
    'wo_schedule', 'wo_completion', 'utilization', 'reliability',
}


def _hours_between(start, end):
    if start is None or end is None:
        return 0.0
    if isinstance(start, datetime):
        delta = (end - start).total_seconds() / 3600
    else:
        delta = (end.hour + end.minute / 60) - (start.hour + start.minute / 60)
    if delta < 0:
        delta += 24
    return round(delta, 4)


def _report_hours(item):
    if item.downtime_h is not None:
        return max(float(item.downtime_h), 0)
    return _hours_between(item.maintenance_start, item.maintenance_end)


def _order_hours(order):
    if order.downtime_h is not None:
        return max(float(order.downtime_h), 0)
    if order.labor_hours is not None:
        return max(float(order.labor_hours), 0)
    return _hours_between(order.start_time, order.end_time)


def _pct(part, whole):
    if not whole:
        return None
    return round(part / whole * 100, 1)


def _per(part, whole):
    if not whole:
        return None
    return round(part / whole, 2)


def _reliability(operating_hours, mtbf):
    if operating_hours <= 0:
        return None
    if not mtbf:
        return 100.0
    return round(math.exp(-(operating_hours / mtbf)) * 100, 1)


def _in_period(value, start, end):
    if value is None:
        return False
    if isinstance(value, datetime):
        value = value.date()
    return start <= value <= end


def _blank_hours():
    return {name: 0.0 for name in HOUR_TYPES}


def compute_kpi(db: Session, plant_id=None, line_id=None, equipment_id=None, technician_id=None, date_from=None, date_to=None):
    all_equipment = db.query(Equipment).all()
    equipment_by_id = {row.equipment_id: row for row in all_equipment}
    plants = [row for row in db.query(Plant).all() if row.active is not False]
    plant_lines = [row for row in db.query(PlantLine).all() if row.active is not False]
    line_by_id = {row.line_id: row for row in plant_lines}
    line_by_number = {
        (row.plant_id, str(row.line_number)): row
        for row in plant_lines if row.line_number is not None
    }
    plant_name = {row.plant_id: row.name for row in plants}
    if plant_id:
        plant_ids = {item for item in (plant_id if isinstance(plant_id, (list, tuple, set)) else [plant_id]) if item}
    else:
        plant_ids = set()
    if not plant_ids:
        plant_ids = None
    single_plant = next(iter(plant_ids)) if plant_ids and len(plant_ids) == 1 else None
    equipment = list(all_equipment)
    if plant_ids:
        equipment = [row for row in equipment if row.plant_id in plant_ids]
    if line_id:
        equipment = [row for row in equipment if row.line_id == line_id]
    if equipment_id:
        equipment = [row for row in equipment if row.equipment_id == equipment_id]
    equipment_ids = {row.equipment_id for row in equipment}
    scoped = bool(plant_ids or line_id or equipment_id)

    def equipment_ok(code, manual_plant=None, manual_line=None):
        if not scoped:
            return True
        if code and code in equipment_ids:
            return True
        if manual_plant or manual_line:
            if plant_ids and manual_plant not in plant_ids:
                return False
            if line_id and manual_line != line_id:
                return False
            if equipment_id:
                return False
            return True
        return False

    reports = db.query(DailyReport).all()
    if technician_id:
        reports = [row for row in reports if row.technician_id == technician_id]
    report_by_id = {row.id: row for row in reports}
    items = db.query(DailyReportItem).all() if reports else []
    items = [row for row in items if row.report_id in report_by_id]

    orders = db.query(WorkOrder).all()
    if technician_id:
        assigned = {
            row.work_order_id
            for row in db.query(WorkOrderAssignment).filter_by(technician_id=technician_id).all()
        }
        orders = [row for row in orders if row.work_order_id in assigned or row.assigned_technician_id == technician_id]
    records = db.query(MachineRecord).all()
    if technician_id:
        records = [row for row in records if row.technician_id == technician_id]
    plans = [row for row in db.query(PMPlan).all() if row.active is not False]
    components = db.query(Component).all()

    dated = []
    for report in reports:
        if report.report_date:
            dated.append(report.report_date)
    for order in orders:
        dated.append(order.planned_date or order.request_date)
    for record in records:
        if record.record_date:
            dated.append(record.record_date)
    dated = [value for value in dated if value]
    today = date.today()
    start = date_from or (min(dated) if dated else today)
    end = date_to or today
    if end < start:
        start, end = end, start
    days = max((end - start).days + 1, 1)
    previous_end = start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=days - 1)

    def pack(window_start, window_end):
        window_items = [
            row for row in items
            if _in_period(report_by_id[row.report_id].report_date, window_start, window_end)
            and equipment_ok(row.equipment_id, row.plant_id, row.line_id)
        ]
        window_orders = [
            row for row in orders
            if _in_period(row.planned_date or row.request_date, window_start, window_end)
            and equipment_ok(row.equipment_id, row.manual_plant_id, row.manual_line_id)
            and row.status != 'Cancelled'
        ]
        window_records = [
            row for row in records
            if _in_period(row.record_date, window_start, window_end)
            and equipment_ok(row.equipment_id)
        ]
        covered_orders = {row.wo_id for row in window_items if row.wo_id}
        accepted_items = [
            row for row in window_items
            if report_by_id[row.report_id].status == 'Approved'
        ]
        hours = _blank_hours()
        for row in accepted_items:
            kind = row.maintenance_type if row.maintenance_type in hours else 'Routine'
            hours[kind] += _report_hours(row)
        for order in window_orders:
            if order.work_order_id in covered_orders:
                continue
            kind = order.work_order_type if order.work_order_type in hours else 'Routine'
            hours[kind] += _order_hours(order)
        for name in hours:
            hours[name] = round(hours[name], 2)
        total_hours = round(sum(hours.values()), 2)
        order_counts = {name: 0 for name in HOUR_TYPES}
        for order in window_orders:
            kind = order.work_order_type if order.work_order_type in order_counts else 'Routine'
            order_counts[kind] += 1
        scheduled_down = hours['Preventive']
        unscheduled_down = round(hours['Corrective'] + hours['Emergency'], 2)
        total_down = round(scheduled_down + unscheduled_down, 2)

        def report_counts_for_time(report):
            if report.status not in RECEIVED_REPORTS or not _in_period(report.report_date, window_start, window_end):
                return False
            if not scoped:
                return True
            linked = [row for row in items if row.report_id == report.id]
            if any(equipment_ok(row.equipment_id, row.plant_id, row.line_id) for row in linked):
                return True
            if line_id or equipment_id:
                return False
            return report.plant_id in plant_ids

        utilization_reports = len([row for row in reports if report_counts_for_time(row)])
        utilization_available = round(utilization_reports * REPORT_SHIFT_HOURS, 2)
        utilization_operating = round(max(utilization_available - total_down, 0), 2)

        asset_count = len(equipment_ids) if scoped else len({row.equipment_id for row in equipment})
        if asset_count == 0:
            asset_count = len({row.equipment_id or row.equipment_code for row in window_items if row.equipment_id or row.equipment_code})
        idle = 0.0
        available = round(asset_count * days * 24, 2) if asset_count else 0.0
        uptime = round(available - idle - (scheduled_down + unscheduled_down), 2)
        operating = round(available - idle - scheduled_down - unscheduled_down, 2)

        failure_orders = [row for row in window_orders if row.work_order_type in FAILURE_TYPES]
        failure_ids = {row.work_order_id for row in failure_orders}
        extra_failures = [
            row for row in window_records
            if row.record_type in FAILURE_TYPES and row.wo_id not in failure_ids
        ]
        failures = len(failure_orders) + len(extra_failures)
        corrective_orders = [row for row in failure_orders if row.work_order_type == 'Corrective']
        corrective_hours = hours['Corrective']

        late_pm_ids = set()
        for order in window_orders:
            if order.work_order_type != 'Preventive' or not order.pm_id or order.status not in CLOSED:
                continue
            finished = order.closing_date.date() if order.closing_date else (order.end_time.date() if order.end_time else None)
            if finished and order.planned_date and finished > order.planned_date:
                late_pm_ids.add(order.pm_id)
        due_plans = []
        on_time = 0
        for plan in plans:
            if not equipment_ok(plan.equipment_id, plan.manual_plant_id, plan.manual_line_id):
                continue
            due_in_window = bool(plan.next_due_date and window_start <= plan.next_due_date <= window_end)
            completed_in_window = _in_period(plan.last_pm_date, window_start, window_end)
            if not due_in_window and not completed_in_window:
                continue
            due_plans.append(plan)
            overdue_now = bool(plan.next_due_date and plan.next_due_date < today)
            if completed_in_window and plan.pm_id not in late_pm_ids and not overdue_now:
                on_time += 1
        overdue_plans = [
            row for row in plans
            if row.next_due_date and row.next_due_date < today
            and equipment_ok(row.equipment_id, row.manual_plant_id, row.manual_line_id)
        ]
        scope_plans = [
            row for row in plans
            if equipment_ok(row.equipment_id, row.manual_plant_id, row.manual_line_id)
        ]
        planned = len([row for row in scope_plans if not row.added_unplanned])
        unplanned = len([row for row in scope_plans if row.added_unplanned])
        preventive_items = [row for row in window_items if row.maintenance_type == 'Preventive']
        if preventive_items:
            plan_by_id = {row.pm_id: row for row in scope_plans}
            unplanned = len([row for row in preventive_items if row.pm_id and plan_by_id.get(row.pm_id) and plan_by_id[row.pm_id].added_unplanned])
            planned = len(preventive_items) - unplanned

        scheduled_orders = [row for row in window_orders if row.work_order_type != 'Emergency']
        scheduled_done = [row for row in scheduled_orders if row.status in CLOSED]
        issued = window_orders
        completed = [row for row in issued if row.status in CLOSED]
        open_orders = [row for row in issued if row.status not in CLOSED]
        overdue_orders = []
        aging = {'1-7': 0, '8-30': 0, '31+': 0}
        for order in issued:
            due = order.planned_date
            if due and due < today and order.status not in CLOSED:
                overdue_orders.append(order)
                age = (today - due).days
                if age <= 7:
                    aging['1-7'] += 1
                elif age <= 30:
                    aging['8-30'] += 1
                else:
                    aging['31+'] += 1

        def located(item):
            registered = equipment_by_id.get(item.equipment_id)
            report = report_by_id[item.report_id]
            item_plant = item.plant_id or (registered.plant_id if registered else None) or report.plant_id
            item_line = item.line_id or (registered.line_id if registered else None)
            if not item_line and item.entered_line_number and item_plant:
                match = line_by_number.get((item_plant, str(item.entered_line_number).strip()))
                if match:
                    item_line = match.line_id
            return item_plant, item_line

        grouped = {}
        grouped_count = {}

        def chart_key(item_plant, item_line):
            if equipment_id:
                return equipment_id
            if line_id:
                return line_id
            if single_plant:
                return item_line or 'unassigned'
            return item_plant or 'unassigned'

        def add_downtime(key, day_value, amount):
            if not key or amount is None:
                return
            hours_value = max(float(amount), 0)
            if isinstance(day_value, datetime):
                day_value = day_value.date()
            if not day_value:
                return
            day_key = day_value.isoformat() if hasattr(day_value, 'isoformat') else str(day_value)
            bucket = grouped.setdefault(key, {})
            bucket[day_key] = bucket.get(day_key, 0) + hours_value
            if hours_value > 0:
                grouped_count[key] = grouped_count.get(key, 0) + 1

        for row in accepted_items:
            if row.maintenance_type not in FAILURE_TYPES and row.maintenance_type != 'Preventive':
                continue
            item_plant, item_line = located(row)
            add_downtime(chart_key(item_plant, item_line), report_by_id[row.report_id].report_date, _report_hours(row))

        # Work-order downtime also belongs on each plant/line bar (skip items already counted from reports).
        for order in window_orders:
            if order.work_order_id in covered_orders:
                continue
            if order.work_order_type not in FAILURE_TYPES and order.work_order_type != 'Preventive':
                continue
            registered = equipment_by_id.get(order.equipment_id)
            item_plant = (registered.plant_id if registered else None) or order.manual_plant_id
            item_line = (registered.line_id if registered else None) or order.manual_line_id
            add_downtime(
                chart_key(item_plant, item_line),
                order.planned_date or order.request_date,
                _order_hours(order),
            )

        if line_id:
            chosen = line_by_id.get(line_id)
            catalog = [(line_id, chosen.name if chosen else line_id)]
            trend_by = 'line'
        elif equipment_id:
            chosen = equipment_by_id.get(equipment_id)
            catalog = [(equipment_id, f'{chosen.name} ({equipment_id})' if chosen else equipment_id)]
            trend_by = 'equipment'
        elif single_plant:
            catalog = [
                (row.line_id, row.name)
                for row in sorted(plant_lines, key=lambda row: (row.line_number or 0, row.name))
                if row.plant_id == single_plant
            ]
            trend_by = 'line'
        elif plant_ids:
            catalog = [
                (row.plant_id, row.name)
                for row in sorted(plants, key=lambda row: row.name)
                if row.plant_id in plant_ids
            ]
            trend_by = 'plant'
        else:
            catalog = [(row.plant_id, row.name) for row in sorted(plants, key=lambda row: row.name)]
            trend_by = 'plant'
        if grouped.get('unassigned') and not any(key == 'unassigned' for key, _name in catalog):
            catalog.append(('unassigned', 'Unassigned'))
        known = {key for key, _name in catalog}
        for key in grouped:
            if key in known:
                continue
            line = line_by_id.get(key)
            catalog.append((key, plant_name.get(key) or (line.name if line else key)))

        dates = []
        cursor = max(window_start, window_end - timedelta(days=11))
        while cursor <= window_end:
            dates.append(cursor.isoformat())
            cursor += timedelta(days=1)
        trend_series = []
        total_by_day = {day: 0.0 for day in dates}
        for key, label in catalog:
            points = []
            for day in dates:
                value = round(grouped.get(key, {}).get(day, 0), 2)
                total_by_day[day] += value
                points.append({'date': day, 'hours': value})
            trend_series.append({'id': key, 'name': label, 'points': points})
        trend = [{'date': day, 'hours': round(total_by_day[day], 2)} for day in dates]

        # Downtime bars by plant/line (or equipment), with Availability on the line.
        # The date filter sets the period; categories are plants, or lines when one plant is selected.
        window_days = max((window_end - window_start).days + 1, 1)
        assets_by_key = {}
        for row in all_equipment:
            if plant_ids and row.plant_id not in plant_ids:
                continue
            if line_id and row.line_id != line_id:
                continue
            if equipment_id and row.equipment_id != equipment_id:
                continue
            if equipment_id:
                asset_key = equipment_id
            elif line_id:
                asset_key = line_id
            elif single_plant:
                asset_key = row.line_id or 'unassigned'
            else:
                asset_key = row.plant_id or 'unassigned'
            assets_by_key[asset_key] = assets_by_key.get(asset_key, 0) + 1

        # One black bar per plant (or per line when a single plant is selected) — never merge plants.
        pareto = []
        for key, label in catalog:
            if key == 'unassigned' and not grouped.get(key):
                continue
            category_hours = round(sum(grouped.get(key, {}).values()), 2)
            count = int(grouped_count.get(key, 0))
            assets = int(assets_by_key.get(key, 0) or 0)
            available_h = round(assets * window_days * 24, 2) if assets else 0.0
            uptime_h = max(available_h - category_hours, 0)
            pareto.append({
                'id': key,
                'name': label,
                'count': count,
                'hours': category_hours,
                'availability': _pct(uptime_h, available_h) if available_h else None,
            })
        # Keep every plant/line visible; only trim when the list is very long.
        pareto.sort(key=lambda row: (-row['hours'], -row['count'], str(row['name']).lower()))
        if trend_by in ('plant', 'line'):
            pareto = pareto[:24]
        else:
            pareto = [row for row in pareto if row['count'] > 0 or row['hours'] > 0][:12]
        total_hours_pareto = sum(row['hours'] for row in pareto) or 1
        running = 0.0
        for row in pareto:
            running += row['hours']
            row['cumulative_pct'] = round(100 * running / total_hours_pareto, 1)

        return {
            'availability': _pct(max(uptime, 0), available - idle) if available else None,
            'uptime_h': max(uptime, 0) if available else 0,
            'available_h': available,
            'idle_h': idle,
            'downtime_h': total_down,
            'scheduled_downtime_h': scheduled_down,
            'unscheduled_downtime_h': unscheduled_down,
            'operating_h': max(operating, 0) if available else 0,
            'utilization': _pct(utilization_operating, utilization_available),
            'utilization_operating_h': utilization_operating,
            'utilization_available_h': utilization_available,
            'utilization_reports': utilization_reports,
            'mtbf': _per(max(operating, 0), failures) if available else None,
            'reliability': _reliability(max(operating, 0) if available else 0, _per(max(operating, 0), failures) if available else None),
            'mttr': _per(corrective_hours, len(corrective_orders)) if corrective_orders else None,
            'failures': failures,
            'corrective_events': len(corrective_orders),
            'corrective_hours': corrective_hours,
            'failure_rate_1000h': round(failures / max(operating, 0) * 1000, 2) if operating > 0 else None,
            'pm_compliance': _pct(on_time, len(due_plans)),
            'pm_on_time': on_time,
            'pm_due': len(due_plans),
            'pm_overdue': len(overdue_plans),
            'pm_overdue_pct': _pct(len(overdue_plans), len(due_plans)),
            'planned_pm': planned,
            'unplanned_pm': unplanned,
            'pm_total': planned + unplanned,
            'planned_pm_pct': _pct(planned, planned + unplanned),
            'unplanned_pm_pct': _pct(unplanned, planned + unplanned),
            'hours': hours,
            'total_hours': total_hours,
            'order_counts': order_counts,
            'corrective_pct': _pct(hours['Corrective'], total_hours),
            'preventive_pct': _pct(hours['Preventive'], total_hours),
            'emergency_to_routine': _pct(hours['Emergency'], hours['Routine']),
            'emergency_to_preventive': _pct(hours['Emergency'], hours['Preventive']),
            'wo_schedule': _pct(len(scheduled_done), len(scheduled_orders)),
            'wo_scheduled': len(scheduled_orders),
            'wo_scheduled_done': len(scheduled_done),
            'wo_completion': _pct(len(completed), len(issued)),
            'wo_issued': len(issued),
            'wo_completed': len(completed),
            'wo_open': len(open_orders),
            'backlog': _pct(len(open_orders), len(issued)),
            'wo_overdue': len(overdue_orders),
            'wo_overdue_pct': _pct(len(overdue_orders), len(issued)),
            'wo_aging': aging,
            'equipment_count': asset_count,
            'trend': trend[-12:],
            'trend_by': trend_by,
            'trend_series': trend_series,
            'pareto': pareto,
        }

    current = pack(start, end)
    previous = pack(previous_start, previous_end)
    life = []
    for row in components:
        if not equipment_ok(row.equipment_id) or not row.installation_date:
            continue
        finish = row.removal_date or today
        life.append({
            'component_id': row.component_id,
            'name': row.name,
            'equipment_id': row.equipment_id,
            'life_days': (finish - row.installation_date).days,
            'in_service': row.removal_date is None,
        })
    life.sort(key=lambda row: row['life_days'], reverse=True)
    targets = _targets_for(db, single_plant, line_id, equipment_id)
    current.update({
        'period': {'from': start.isoformat(), 'to': end.isoformat(), 'days': days},
        'previous': {key: previous.get(key) for key in (
            'availability', 'mtbf', 'mttr', 'pm_compliance', 'downtime_h', 'failures',
            'planned_pm_pct', 'unplanned_pm_pct', 'corrective_pct', 'preventive_pct',
            'wo_schedule', 'wo_completion', 'wo_overdue', 'failure_rate_1000h', 'pm_overdue',
        )},
        'components': life[:8],
        'targets': targets,
        'component_life_avg': round(sum(row['life_days'] for row in life) / len(life), 1) if life else None,
    })
    return current


def _targets_for(db, plant_id, line_id, equipment_id):
    rows = db.query(KpiTarget).all()
    chosen = {}
    for row in rows:
        score = 0
        if row.equipment_id:
            if row.equipment_id != equipment_id:
                continue
            score = 3
        elif row.line_id:
            if row.line_id != line_id or equipment_id:
                continue
            score = 2
        elif row.plant_id:
            if row.plant_id != plant_id or line_id or equipment_id:
                continue
            score = 1
        elif plant_id or line_id or equipment_id:
            score = 0
        else:
            score = 0
        current = chosen.get(row.metric)
        if current is None or score >= current[0]:
            chosen[row.metric] = (score, row.target_value)
    return {metric: value for metric, (score, value) in chosen.items()}


def save_kpi_target(db, metric, target_value, plant_id=None, line_id=None, equipment_id=None):
    row = db.query(KpiTarget).filter_by(
        metric=metric, plant_id=plant_id, line_id=line_id, equipment_id=equipment_id,
    ).first()
    if row is None:
        row = KpiTarget(metric=metric, plant_id=plant_id, line_id=line_id, equipment_id=equipment_id, target_value=target_value)
        db.add(row)
    else:
        row.target_value = target_value
    db.commit()
    return row
