"""Phone notices for technician accounts.

A new work order is pushed when it is sent to a technician. Preventive tasks
due today are pushed once each Baghdad morning to the technicians who own them.
"""
import base64
import json
import threading
import time
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import (
    AnnualPMDayTask,
    AppSecret,
    DailyReportItem,
    Equipment,
    PushDelivery,
    PushSubscription,
    SparePart,
    User,
    WorkOrder,
)

try:
    from pywebpush import WebPushException, webpush
except ImportError:
    WebPushException = Exception
    webpush = None

_started = False
VAPID_SUBJECT = 'mailto:rayan-cmms@users.noreply.github.com'


def plant_today():
    return datetime.now(timezone(timedelta(hours=3))).date()


def _public_key(private_key):
    numbers = private_key.public_key().public_numbers()
    raw = b'\x04' + numbers.x.to_bytes(32, 'big') + numbers.y.to_bytes(32, 'big')
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def vapid_material(db: Session):
    row = db.query(AppSecret).filter_by(key='vapid').first()
    if row and row.value:
        data = json.loads(row.value)
        if data.get('private_key') and data.get('public_key'):
            return data['private_key'], data['public_key']
    private_key = ec.generate_private_key(ec.SECP256R1())
    raw = private_key.private_numbers().private_value.to_bytes(32, 'big')
    private_b64 = base64.urlsafe_b64encode(raw).decode().rstrip('=')
    public = _public_key(private_key)
    payload = json.dumps({'private_key': private_b64, 'public_key': public})
    if row:
        row.value = payload
    else:
        db.add(AppSecret(key='vapid', value=payload))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = db.query(AppSecret).filter_by(key='vapid').first()
        data = json.loads(row.value)
        return data['private_key'], data['public_key']
    return private_b64, public


def public_key(db: Session) -> str:
    return vapid_material(db)[1]


def save_subscription(db: Session, user, endpoint: str, p256dh: str, auth: str):
    if user.role not in ('TECHNICIAN', 'LUBRICATION_TECHNICIAN', 'MAINTENANCE_ENGINEER'):
        return False
    endpoint = (endpoint or '').strip()
    if not endpoint.startswith('https://') or len(endpoint) > 2000:
        return False
    if not p256dh or not auth or len(p256dh) > 255 or len(auth) > 255:
        return False
    row = db.query(PushSubscription).filter_by(endpoint=endpoint).first()
    if row:
        row.user_id = user.id
        row.p256dh = p256dh
        row.auth = auth
    else:
        db.add(PushSubscription(user_id=user.id, endpoint=endpoint, p256dh=p256dh, auth=auth))
    db.commit()
    return True


def _send(db: Session, user_id: int, title: str, body: str, url: str, private_key: str) -> bool:
    if webpush is None:
        return False
    subscriptions = db.query(PushSubscription).filter_by(user_id=user_id).all()
    if not subscriptions or not private_key:
        return False
    payload = json.dumps({'title': title, 'body': body, 'url': url}, ensure_ascii=False)
    sent = False
    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    'endpoint': subscription.endpoint,
                    'keys': {'p256dh': subscription.p256dh, 'auth': subscription.auth},
                },
                data=payload,
                vapid_private_key=private_key,
                vapid_claims={'sub': VAPID_SUBJECT},
                timeout=10,
            )
            sent = True
        except WebPushException as error:
            status = getattr(getattr(error, 'response', None), 'status_code', None)
            if status in (404, 410):
                db.delete(subscription)
        except Exception:
            continue
    return sent


def _remember(db: Session, user_id: int, kind: str, ref: str) -> bool:
    if db.query(PushDelivery).filter_by(user_id=user_id, kind=kind, ref=ref).first():
        return False
    db.add(PushDelivery(user_id=user_id, kind=kind, ref=ref))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return False
    return True


def _amount(value):
    return f'{round(float(value), 3):.3f}'.rstrip('0').rstrip('.') or '0'


def queue_critical_stock_pushes(part_ids):
    ids = [item for item in (part_ids or []) if item]
    if not ids:
        return
    threading.Thread(target=_push_critical_stock, args=(ids,), daemon=True).start()


def _push_critical_stock(part_ids):
    db = SessionLocal()
    try:
        engineers = db.query(User).filter(User.role == 'MAINTENANCE_ENGINEER', User.is_active == True).all()
        if not engineers:
            return
        private_key, _public = vapid_material(db)
        for part_id in part_ids:
            part = db.query(SparePart).filter_by(part_id=part_id).first()
            if part is None or part.stock_qty is None or part.critical_qty is None:
                continue
            if float(part.stock_qty) > float(part.critical_qty):
                continue
            unit = part.unit or 'pcs'
            body = (
                f'{part.part_number} — {part.name}. '
                f'الرصيد {_amount(part.stock_qty)} {unit}، والحد الحرج {_amount(part.critical_qty)} {unit}.'
            )
            for engineer in engineers:
                _send(db, engineer.id, 'رصيد حرج', body[:240], '/index.html#spare-parts', private_key)
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def clear_work_order_push(db: Session, technician_id: str, work_order_id: str):
    account = db.query(User).filter(User.technician_id == technician_id, User.is_active == True).first()
    if not account:
        return
    db.query(PushDelivery).filter_by(user_id=account.id, kind='work_order', ref=work_order_id).delete(synchronize_session=False)


def queue_work_order_pushes(technician_ids, work_order):
    ids = [item for item in (technician_ids or []) if item]
    if not ids or not getattr(work_order, 'work_order_id', None):
        return
    threading.Thread(
        target=_push_work_orders,
        args=(ids, work_order.work_order_id, work_order.equipment_id, work_order.manual_equipment_name or ''),
        daemon=True,
    ).start()


def _push_work_orders(technician_ids, work_order_id, equipment_id, manual_name):
    db = SessionLocal()
    try:
        equipment = db.query(Equipment).filter_by(equipment_id=equipment_id).first() if equipment_id else None
        name = (equipment.name if equipment else '') or manual_name or ''
        detail = f'{work_order_id} — {name}' if name else work_order_id
        body = f'{detail}. أُرسل إليك، اقبله خلال 24 ساعة.'
        private_key, _public = vapid_material(db)
        for technician_id in technician_ids:
            account = db.query(User).filter(
                User.technician_id == technician_id,
                User.is_active == True,
                User.role.in_(('TECHNICIAN', 'LUBRICATION_TECHNICIAN')),
            ).first()
            if not account or not _remember(db, account.id, 'work_order', work_order_id):
                continue
            if _send(db, account.id, 'أمر صيانة جديد', body, '/index.html#work-orders', private_key):
                db.commit()
            else:
                db.rollback()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _open_preventive_today(db: Session, today):
    tasks = db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.work_date == today,
        or_(
            AnnualPMDayTask.maintenance_type.in_(('Preventive', '')),
            AnnualPMDayTask.maintenance_type.is_(None),
        ),
    ).order_by(AnnualPMDayTask.sort_order, AnnualPMDayTask.id).all()
    if not tasks:
        return []
    order_ids = [task.work_order_id for task in tasks if task.work_order_id]
    closed = set()
    done_orders = set()
    if order_ids:
        closed = {
            row.work_order_id
            for row in db.query(WorkOrder).filter(
                WorkOrder.work_order_id.in_(order_ids),
                WorkOrder.status.in_(('Closed', 'Completed')),
            ).all()
        }
        done_orders = {
            row.wo_id
            for row in db.query(DailyReportItem).filter(
                DailyReportItem.wo_id.in_(order_ids),
                DailyReportItem.maintenance_completed == True,
            ).all()
            if row.wo_id
        }
    return [
        task for task in tasks
        if not task.work_order_id or (task.work_order_id not in closed and task.work_order_id not in done_orders)
    ]


def _pm_body(labels):
    if len(labels) == 1:
        return f'مهمة صيانة وقائية اليوم: {labels[0]}'
    shown = '، '.join(labels[:3])
    if len(labels) > 3:
        shown += f' و{len(labels) - 3} أخرى'
    return f'لديك {len(labels)} مهام صيانة وقائية اليوم: {shown}'


def send_today_pm_notices():
    db = SessionLocal()
    try:
        today = plant_today()
        tasks = _open_preventive_today(db, today)
        if not tasks:
            return 0
        technicians = db.query(User).filter(User.role == 'TECHNICIAN', User.is_active == True).all()
        assigned = db.query(User).filter(
            User.role.in_(('TECHNICIAN', 'LUBRICATION_TECHNICIAN')),
            User.is_active == True,
        ).all()
        by_code = {user.technician_id: user for user in assigned if user.technician_id}
        buckets = {}
        shared = []
        for task in tasks:
            label = ' — '.join(part for part in (task.machine_name or task.machine_code, task.task) if part) or 'مهمة وقائية'
            owner = by_code.get(task.technician_id) if task.technician_id else None
            if owner:
                buckets.setdefault(owner.id, []).append(label)
            else:
                shared.append(label)
        if shared:
            for user in technicians:
                buckets.setdefault(user.id, []).extend(shared)
        sent = 0
        ref = today.isoformat()
        private_key, _public = vapid_material(db)
        for user_id, labels in buckets.items():
            if not labels or not _remember(db, user_id, 'pm_today', ref):
                continue
            if _send(db, user_id, 'صيانة وقائية اليوم', _pm_body(labels)[:240], '/index.html#pm-schedule', private_key):
                db.commit()
                sent += 1
            else:
                db.rollback()
        return sent
    except Exception:
        db.rollback()
        return 0
    finally:
        db.close()


def _seconds_until_window():
    now = datetime.now(timezone(timedelta(hours=3))).replace(tzinfo=None)
    if 7 <= now.hour < 20:
        return 0
    target = now.replace(hour=7, minute=0, second=0, microsecond=0)
    if now.hour >= 20:
        target += timedelta(days=1)
    return max(60, (target - now).total_seconds())


def _loop():
    while True:
        wait = _seconds_until_window()
        if wait:
            time.sleep(wait)
        else:
            time.sleep(15)
        try:
            send_today_pm_notices()
        except Exception:
            pass
        now = datetime.now(timezone(timedelta(hours=3))).replace(tzinfo=None)
        nxt = (now + timedelta(days=1)).replace(hour=7, minute=0, second=0, microsecond=0)
        time.sleep(max(60, (nxt - now).total_seconds()))


def start_phone_notices():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name='phone-notices', daemon=True).start()
