from datetime import date, datetime, time
from sqlalchemy import String, Integer, Float, Date, DateTime, Text, Boolean, ForeignKey, Time, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base

class User(Base):
    __tablename__='users'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    username: Mapped[str]=mapped_column(String(80),unique=True,index=True)
    password_hash: Mapped[str]=mapped_column(String(255))
    full_name: Mapped[str]=mapped_column(String(150))
    role: Mapped[str]=mapped_column(String(50))
    technician_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    is_active: Mapped[bool]=mapped_column(Boolean,default=True)
    created_at: Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow)
    last_login: Mapped[datetime|None]=mapped_column(DateTime,nullable=True)

class Plant(Base):
    __tablename__='plants'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    plant_id: Mapped[str]=mapped_column(String(50),unique=True,index=True)
    name: Mapped[str]=mapped_column(String(150))
    active: Mapped[bool]=mapped_column(Boolean,default=True)

class PlantLine(Base):
    __tablename__='plant_lines'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    line_id: Mapped[str]=mapped_column(String(50),unique=True,index=True)
    plant_id: Mapped[str]=mapped_column(String(50),ForeignKey('plants.plant_id'))
    line_number: Mapped[int|None]=mapped_column(Integer,nullable=True)
    name: Mapped[str]=mapped_column(String(150))
    active: Mapped[bool]=mapped_column(Boolean,default=True)
    __table_args__=(UniqueConstraint('plant_id','line_number',name='uq_plant_line_number'),)

class LineSection(Base):
    __tablename__='line_sections'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    section_id: Mapped[str]=mapped_column(String(80),unique=True,index=True)
    line_id: Mapped[str]=mapped_column(String(50),ForeignKey('plant_lines.line_id'),index=True)
    name: Mapped[str]=mapped_column(String(150))
    sort_order: Mapped[int]=mapped_column(Integer,default=1)

class Equipment(Base):
    __tablename__='equipment'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    equipment_id: Mapped[str]=mapped_column(String(50),unique=True,index=True)
    name: Mapped[str]=mapped_column(String(150))
    equipment_type: Mapped[str]=mapped_column(String(100))
    plant_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    line_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    section_id: Mapped[str|None]=mapped_column(String(80),nullable=True)
    area: Mapped[str|None]=mapped_column(String(100),nullable=True)
    manufacturer: Mapped[str|None]=mapped_column(String(100),nullable=True)
    commissioning_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    model: Mapped[str|None]=mapped_column(String(100),nullable=True)
    serial_number: Mapped[str|None]=mapped_column(String(100),nullable=True)
    criticality: Mapped[str]=mapped_column(String(40),default='Important')
    status: Mapped[str]=mapped_column(String(50),default='Running')
    capacity: Mapped[float|None]=mapped_column(Float,nullable=True)
    capacity_unit: Mapped[str|None]=mapped_column(String(30),nullable=True)
    motor_power_kw: Mapped[float|None]=mapped_column(Float,nullable=True)
    operating_hours: Mapped[float|None]=mapped_column(Float,nullable=True)
    condition: Mapped[str|None]=mapped_column(String(50),nullable=True)
    notes: Mapped[str|None]=mapped_column(Text,nullable=True)

class Component(Base):
    __tablename__='components'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    component_id: Mapped[str]=mapped_column(String(60),unique=True,index=True)
    equipment_id: Mapped[str]=mapped_column(String(50),ForeignKey('equipment.equipment_id'))
    name: Mapped[str]=mapped_column(String(150))
    component_type: Mapped[str|None]=mapped_column(String(100),nullable=True)
    manufacturer: Mapped[str|None]=mapped_column(String(100),nullable=True)
    part_number: Mapped[str|None]=mapped_column(String(100),nullable=True)
    installation_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    removal_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    status: Mapped[str]=mapped_column(String(50),default='In Service')
    notes: Mapped[str|None]=mapped_column(Text,nullable=True)

class Technician(Base):
    __tablename__='technicians'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    technician_id: Mapped[str]=mapped_column(String(50),unique=True,index=True)
    name: Mapped[str]=mapped_column(String(150))
    department: Mapped[str]=mapped_column(String(100),default='Mechanical')
    skill_level: Mapped[str|None]=mapped_column(String(50),nullable=True)
    shift: Mapped[str|None]=mapped_column(String(20),nullable=True)
    status: Mapped[str]=mapped_column(String(30),default='Active')

class PMPlan(Base):
    __tablename__='pm_plans'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    pm_id: Mapped[str]=mapped_column(String(60),unique=True,index=True)
    equipment_id: Mapped[str|None]=mapped_column(String(50),ForeignKey('equipment.equipment_id'),nullable=True)
    manual_equipment_code: Mapped[str|None]=mapped_column(String(50),nullable=True,index=True)
    manual_equipment_name: Mapped[str|None]=mapped_column(String(150),nullable=True)
    manual_plant_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    manual_line_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    component_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    pm_type: Mapped[str]=mapped_column(String(50),default='Preventive')
    task: Mapped[str]=mapped_column(Text)
    frequency: Mapped[str]=mapped_column(String(50))
    frequency_value: Mapped[int]=mapped_column(Integer,default=1)
    last_pm_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    next_due_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    estimated_time_h: Mapped[float|None]=mapped_column(Float,nullable=True)
    priority: Mapped[str]=mapped_column(String(20),default='Medium')
    active: Mapped[bool]=mapped_column(Boolean,default=True)
    sop_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    added_unplanned: Mapped[bool]=mapped_column(Boolean,default=False)
    added_reason: Mapped[str|None]=mapped_column(Text,nullable=True)

class AnnualPMPlan(Base):
    __tablename__='annual_pm_plans'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    plant_id: Mapped[str]=mapped_column(String(50),ForeignKey('plants.plant_id'),index=True)
    year: Mapped[int]=mapped_column(Integer)
    __table_args__=(UniqueConstraint('plant_id','year',name='uq_annual_pm_plant_year'),)

class AnnualPMItem(Base):
    __tablename__='annual_pm_items'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    plan_id: Mapped[int]=mapped_column(Integer,ForeignKey('annual_pm_plans.id'))
    sort_order: Mapped[int]=mapped_column(Integer,default=0)
    machine_code: Mapped[str]=mapped_column(String(80),default='')
    machine_name: Mapped[str]=mapped_column(String(150),default='')
    task: Mapped[str]=mapped_column(Text,default='')
    frequency_time: Mapped[str]=mapped_column(String(40),default='')
    frequency_hours: Mapped[str]=mapped_column(String(40),default='')
    maintenance_type: Mapped[str]=mapped_column(String(40),default='Preventive')
    line_key: Mapped[str]=mapped_column(String(40),default='')
    weeks: Mapped[str]=mapped_column(Text,default='')
    days: Mapped[str]=mapped_column(Text,default='')

class AnnualPMDayTask(Base):
    __tablename__='annual_pm_day_tasks'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    plan_id: Mapped[int]=mapped_column(Integer,ForeignKey('annual_pm_plans.id'),index=True)
    work_date: Mapped[date]=mapped_column(Date,index=True)
    sort_order: Mapped[int]=mapped_column(Integer,default=0)
    machine_code: Mapped[str]=mapped_column(String(80),default='')
    machine_name: Mapped[str]=mapped_column(String(150),default='')
    task: Mapped[str]=mapped_column(Text,default='')
    maintenance_type: Mapped[str]=mapped_column(String(40),default='Preventive')
    source_key: Mapped[str]=mapped_column(String(40),default='',index=True)
    technician_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    work_order_id: Mapped[str|None]=mapped_column(String(60),nullable=True,index=True)
    released_at: Mapped[datetime|None]=mapped_column(DateTime,nullable=True)

class SOP(Base):
    __tablename__='sops'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    sop_id: Mapped[str]=mapped_column(String(60),unique=True,index=True)
    equipment_id: Mapped[str]=mapped_column(String(50),ForeignKey('equipment.equipment_id'))
    component_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    title: Mapped[str]=mapped_column(String(200))
    sop_type: Mapped[str|None]=mapped_column(String(80),nullable=True)
    revision: Mapped[str]=mapped_column(String(30),default='00')
    effective_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    review_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    prepared_by: Mapped[str|None]=mapped_column(String(150),nullable=True)
    approved_by: Mapped[str|None]=mapped_column(String(150),nullable=True)
    iso_classification: Mapped[str|None]=mapped_column(String(150),nullable=True)
    status: Mapped[str]=mapped_column(String(40),default='Draft')
    document_path: Mapped[str|None]=mapped_column(String(500),nullable=True)
    notes: Mapped[str|None]=mapped_column(Text,nullable=True)

class WorkOrder(Base):
    __tablename__='work_orders'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    work_order_id: Mapped[str]=mapped_column(String(60),unique=True,index=True)
    work_order_type: Mapped[str]=mapped_column(String(50))
    equipment_id: Mapped[str|None]=mapped_column(String(50),ForeignKey('equipment.equipment_id'),nullable=True)
    manual_equipment_code: Mapped[str|None]=mapped_column(String(50),nullable=True,index=True)
    manual_equipment_name: Mapped[str|None]=mapped_column(String(150),nullable=True)
    manual_plant_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    manual_line_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    component_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    pm_id: Mapped[str|None]=mapped_column(String(60),nullable=True,index=True)
    priority: Mapped[str]=mapped_column(String(20),default='Medium')
    status: Mapped[str]=mapped_column(String(30),default='Open')
    problem_description: Mapped[str|None]=mapped_column(Text,nullable=True)
    work_description: Mapped[str|None]=mapped_column(Text,nullable=True)
    request_date: Mapped[date]=mapped_column(Date,default=date.today)
    planned_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    assigned_technician_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    assignments: Mapped[list['WorkOrderAssignment']] = relationship(back_populates='work_order', cascade='all, delete-orphan', lazy='selectin')
    start_time: Mapped[datetime|None]=mapped_column(DateTime,nullable=True)
    end_time: Mapped[datetime|None]=mapped_column(DateTime,nullable=True)
    downtime_h: Mapped[float|None]=mapped_column(Float,nullable=True)
    labor_hours: Mapped[float|None]=mapped_column(Float,nullable=True)
    failure_mode: Mapped[str|None]=mapped_column(String(100),nullable=True)
    failure_cause: Mapped[str|None]=mapped_column(String(150),nullable=True)
    corrective_action: Mapped[str|None]=mapped_column(Text,nullable=True)
    crew_type: Mapped[str|None]=mapped_column(String(30),nullable=True)
    result: Mapped[str|None]=mapped_column(String(50),nullable=True)
    verification: Mapped[str|None]=mapped_column(Text,nullable=True)
    parts_used: Mapped[str|None]=mapped_column(Text,nullable=True)
    closed_by: Mapped[str|None]=mapped_column(String(80),nullable=True)
    closing_date: Mapped[datetime|None]=mapped_column(DateTime,nullable=True)
    created_by: Mapped[str]=mapped_column(String(80),default='SYSTEM')
    records_committed: Mapped[bool]=mapped_column(Boolean,default=False)

    @property
    def assigned_technician_ids(self) -> list[str]:
        ids = [row.technician_id for row in self.assignments]
        if self.assigned_technician_id and self.assigned_technician_id not in ids:
            ids.insert(0, self.assigned_technician_id)
        return ids

    @property
    def assignment_states(self) -> list[dict]:
        return [
            {
                'technician_id': row.technician_id,
                'response': row.response or 'Pending',
                'assigned_at': row.assigned_at,
            }
            for row in self.assignments
        ]

class WorkOrderAssignment(Base):
    __tablename__ = 'work_order_assignments'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[str] = mapped_column(String(60), ForeignKey('work_orders.work_order_id'), index=True)
    technician_id: Mapped[str] = mapped_column(String(50), ForeignKey('technicians.technician_id'), index=True)
    response: Mapped[str] = mapped_column(String(20), default='Pending')
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    work_order: Mapped['WorkOrder'] = relationship(back_populates='assignments')
    __table_args__ = (UniqueConstraint('work_order_id', 'technician_id', name='uq_wo_technician'),)

class DailyReport(Base):
    __tablename__ = 'daily_reports'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)

    # الفني يؤخذ من حساب المستخدم في الـAPI
    technician_id: Mapped[str] = mapped_column(
        String(50),
        ForeignKey('technicians.technician_id'),
        index=True,
    )

    # يبقى للتوافق مع تقرير له WO رئيسي؛ الربط التفصيلي موجود في Items
    work_order_id: Mapped[str | None] = mapped_column(
        String(60), nullable=True, index=True
    )
    equipment_id: Mapped[str | None] = mapped_column(
        String(50), nullable=True, index=True
    )
    plant_id: Mapped[str | None] = mapped_column(
        String(50), nullable=True, index=True
    )

    # بيانات التقرير العامة
    work_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    finding: Mapped[str | None] = mapped_column(Text, nullable=True)
    action_taken: Mapped[str | None] = mapped_column(Text, nullable=True)
    general_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    equipment_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    labor_hours: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Workflow
    status: Mapped[str] = mapped_column(
        String(30), default='Draft', index=True
    )
    shift: Mapped[str | None] = mapped_column(String(30), nullable=True)
    shift_engineer: Mapped[str | None] = mapped_column(String(150), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    approved_by: Mapped[str | None] = mapped_column(
        String(150), nullable=True
    )
    locked_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    return_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DailyReportItem(Base):
    __tablename__ = 'daily_report_items'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey('daily_reports.id'),
        index=True,
    )

    # كل معدة مذكورة في التقرير لها Item مستقل
    equipment_id: Mapped[str] = mapped_column(
        String(50), index=True
    )
    equipment_code: Mapped[str | None] = mapped_column(
        String(50), nullable=True, index=True
    )
    equipment_name: Mapped[str | None] = mapped_column(
        String(150), nullable=True
    )
    plant_id: Mapped[str | None] = mapped_column(
        String(50), nullable=True, index=True
    )
    line_id: Mapped[str | None] = mapped_column(
        String(50), nullable=True, index=True
    )
    entered_line_number: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )
    is_manual_entry: Mapped[bool] = mapped_column(
        Boolean, default=False
    )
    component_id: Mapped[str | None] = mapped_column(
        String(60), nullable=True, index=True
    )

    # نوع العمل
    maintenance_type: Mapped[str] = mapped_column(
        String(40), default='Corrective', index=True
    )

    # وقت الصيانة الفعلي
    maintenance_start: Mapped[time | None] = mapped_column(
        Time, nullable=True
    )
    maintenance_end: Mapped[time | None] = mapped_column(
        Time, nullable=True
    )

    # وقت توقف المعدة منفصل عن وقت عمل الفني
    # لأن Maintenance Time و Downtime ليسا بالضرورة متساويين.
    downtime_start: Mapped[time | None] = mapped_column(
        Time, nullable=True
    )
    downtime_end: Mapped[time | None] = mapped_column(
        Time, nullable=True
    )
    downtime_h: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    downtime_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    # تفاصيل المشكلة والعمل
    failure_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    action_taken: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    # حاليًا نص فقط، وليس Inventory
    spare_parts: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    maintenance_completed: Mapped[bool] = mapped_column(
        Boolean, default=False
    )

    # الربط مع PM / WO
    pm_id: Mapped[str | None] = mapped_column(
        String(60), nullable=True, index=True
    )
    wo_id: Mapped[str | None] = mapped_column(
        String(60), nullable=True, index=True
    )

class PendingEquipment(Base):
    __tablename__ = 'pending_equipment'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    equipment_code: Mapped[str] = mapped_column(String(50), index=True)
    equipment_name: Mapped[str] = mapped_column(String(150))
    plant_id: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    line_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    line_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    report_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    technician_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default='Pending', index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class MachineRecord(Base):
    __tablename__='machine_records'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    equipment_id: Mapped[str]=mapped_column(String(50),index=True)
    record_date: Mapped[date]=mapped_column(Date)
    record_type: Mapped[str]=mapped_column(String(40))
    daily_report_id: Mapped[int|None]=mapped_column(Integer,nullable=True)
    wo_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    pm_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    technician_id: Mapped[str|None]=mapped_column(String(50),nullable=True)
    description: Mapped[str|None]=mapped_column(Text,nullable=True)
    cause: Mapped[str|None]=mapped_column(Text,nullable=True)
    action: Mapped[str|None]=mapped_column(Text,nullable=True)
    start_time: Mapped[time|None]=mapped_column(Time,nullable=True)
    end_time: Mapped[time|None]=mapped_column(Time,nullable=True)
    downtime_h: Mapped[float|None]=mapped_column(Float,nullable=True)
    spare_parts: Mapped[str|None]=mapped_column(Text,nullable=True)
    created_at: Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow)

class ISORecord(Base):
    __tablename__='iso_records'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    document_number: Mapped[str]=mapped_column(String(100),unique=True,index=True)
    document_title: Mapped[str]=mapped_column(String(200))
    document_type: Mapped[str|None]=mapped_column(String(100),nullable=True)
    iso_reference: Mapped[str|None]=mapped_column(String(150),nullable=True)
    revision: Mapped[str]=mapped_column(String(30),default='00')
    effective_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    review_date: Mapped[date|None]=mapped_column(Date,nullable=True)
    prepared_by: Mapped[str|None]=mapped_column(String(150),nullable=True)
    approved_by: Mapped[str|None]=mapped_column(String(150),nullable=True)
    status: Mapped[str]=mapped_column(String(40),default='Draft')
    notes: Mapped[str|None]=mapped_column(Text,nullable=True)

class FormNumber(Base):
    __tablename__='form_numbers'
    form_key: Mapped[str]=mapped_column(String(40),primary_key=True)
    form_no: Mapped[str]=mapped_column(String(80),default='')

class Notification(Base):
    __tablename__='notifications'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    user_id: Mapped[int|None]=mapped_column(Integer,nullable=True)
    title: Mapped[str]=mapped_column(String(200))
    message: Mapped[str]=mapped_column(Text)
    kind: Mapped[str|None]=mapped_column(String(60),nullable=True)
    related_id: Mapped[str|None]=mapped_column(String(100),nullable=True)
    is_read: Mapped[bool]=mapped_column(Boolean,default=False)
    created_at: Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow)

class AuditTrail(Base):
    __tablename__='audit_trail'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    user_id: Mapped[int|None]=mapped_column(Integer,nullable=True)
    username: Mapped[str|None]=mapped_column(String(80),nullable=True)
    action: Mapped[str]=mapped_column(String(100))
    entity: Mapped[str]=mapped_column(String(100))
    entity_id: Mapped[str|None]=mapped_column(String(100),nullable=True)
    old_value: Mapped[str|None]=mapped_column(Text,nullable=True)
    new_value: Mapped[str|None]=mapped_column(Text,nullable=True)
    created_at: Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow)

class KpiTarget(Base):
    __tablename__ = 'kpi_targets'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    metric: Mapped[str] = mapped_column(String(40), index=True)
    plant_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    line_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    equipment_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    target_value: Mapped[float] = mapped_column(Float)


class Measurement(Base):
    __tablename__='measurements'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    measurement_id: Mapped[str]=mapped_column(String(60),unique=True)
    work_order_id: Mapped[str]=mapped_column(String(60),ForeignKey('work_orders.work_order_id'))
    equipment_id: Mapped[str]=mapped_column(String(50))
    component_id: Mapped[str|None]=mapped_column(String(60),nullable=True)
    parameter: Mapped[str]=mapped_column(String(100))
    value: Mapped[float|None]=mapped_column(Float,nullable=True)
    unit: Mapped[str|None]=mapped_column(String(30),nullable=True)
    condition: Mapped[str|None]=mapped_column(String(30),nullable=True)

class LubricationReport(Base):
    __tablename__ = 'lubrication_reports'
    __table_args__ = (UniqueConstraint('technician_id', 'report_date', name='uq_lube_tech_date'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    day_name: Mapped[str] = mapped_column(String(20), default='')
    shift: Mapped[str] = mapped_column(String(40))
    technician_id: Mapped[str] = mapped_column(String(50), ForeignKey('technicians.technician_id'), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LubricationLine(Base):
    __tablename__ = 'lubrication_lines'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int] = mapped_column(Integer, ForeignKey('lubrication_reports.id'), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    equipment_code: Mapped[str] = mapped_column(String(50), default='')
    equipment_name: Mapped[str] = mapped_column(String(150), default='')
    component: Mapped[str] = mapped_column(String(150), default='')
    quantity: Mapped[str] = mapped_column(String(40), default='')
    lubricant_name: Mapped[str] = mapped_column(String(150), default='')
    notes: Mapped[str] = mapped_column(Text, default='')
    work_type: Mapped[str] = mapped_column(String(30), default='')
    work_order_id: Mapped[str | None] = mapped_column(String(60), nullable=True, index=True)


class MotorConditionReport(Base):
    __tablename__ = 'motor_condition_reports'
    __table_args__ = (UniqueConstraint('group_key', 'place_key', 'report_date', name='uq_motor_sheet'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    inspection_time: Mapped[str] = mapped_column(String(8), default='')
    inspector_name: Mapped[str] = mapped_column(String(150), default='')
    group_key: Mapped[str] = mapped_column(String(10), index=True)
    place_key: Mapped[str] = mapped_column(String(20), index=True)
    notes: Mapped[str] = mapped_column(Text, default='')
    created_by: Mapped[str] = mapped_column(String(80), default='')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MotorConditionReading(Base):
    __tablename__ = 'motor_condition_readings'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int] = mapped_column(Integer, ForeignKey('motor_condition_reports.id'), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    machine: Mapped[str] = mapped_column(String(150), default='')
    equipment_id: Mapped[str] = mapped_column(String(50), default='')
    plant: Mapped[str] = mapped_column(String(80), default='')
    line_number: Mapped[str] = mapped_column(String(40), default='')
    temp_1: Mapped[str] = mapped_column(String(20), default='')
    temp_2: Mapped[str] = mapped_column(String(20), default='')
    oil_level: Mapped[str] = mapped_column(String(20), default='')
    oil_condition: Mapped[str] = mapped_column(String(20), default='')
    inspection_time: Mapped[str] = mapped_column(String(8), default='')


class PartUsed(Base):
    __tablename__='parts_used'
    id: Mapped[int]=mapped_column(Integer,primary_key=True)
    usage_id: Mapped[str]=mapped_column(String(60),unique=True)
    work_order_id: Mapped[str]=mapped_column(String(60),ForeignKey('work_orders.work_order_id'))
    equipment_id: Mapped[str]=mapped_column(String(50))
    part_number: Mapped[str]=mapped_column(String(100))
    description: Mapped[str|None]=mapped_column(String(200),nullable=True)
    quantity: Mapped[float]=mapped_column(Float,default=1)
    unit: Mapped[str|None]=mapped_column(String(30),nullable=True)
