from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    username: str
    full_name: str
    role: str
    technician_id: str | None = None


class UserCreate(BaseModel):
    username: str
    password: str | None = None
    full_name: str
    role: str
    technician_id: str | None = None
    is_active: bool = True


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: str | None = None
    technician_id: str | None = None
    is_active: bool | None = None
    password: str | None = None


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    technician_id: str | None = None
    is_active: bool
    created_at: datetime
    last_login: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class PlantCreate(BaseModel):
    plant_id: str
    name: str
    active: bool = True


class LineCreate(BaseModel):
    line_id: str
    plant_id: str
    name: str
    active: bool = True


class EquipmentBase(BaseModel):
    equipment_id: str
    name: str
    equipment_type: str
    plant_id: str | None = None
    line_id: str | None = None
    area: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    criticality: str = "B"
    status: str = "Running"
    capacity: float | None = None
    capacity_unit: str | None = None
    motor_power_kw: float | None = None
    operating_hours: float | None = None
    condition: str | None = None
    notes: str | None = None


class EquipmentCreate(EquipmentBase):
    pass


class EquipmentOut(EquipmentBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class ComponentCreate(BaseModel):
    equipment_id: str
    name: str
    component_type: str | None = None
    manufacturer: str | None = None
    part_number: str | None = None
    installation_date: date | None = None
    removal_date: date | None = None
    status: str = "In Service"
    notes: str | None = None


class ComponentOut(ComponentCreate):
    component_id: str
    id: int

    model_config = ConfigDict(from_attributes=True)


class TechnicianCreate(BaseModel):
    technician_id: str
    name: str
    department: str = "Mechanical"
    skill_level: str | None = None
    shift: str | None = None
    status: str = "Active"


class TechnicianOut(TechnicianCreate):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PMCreate(BaseModel):
    equipment_id: str | None = None
    manual_equipment_code: str | None = None
    manual_equipment_name: str | None = None
    manual_plant_id: str | None = None
    manual_line_id: str | None = None
    component_id: str | None = None
    pm_type: str = "Preventive"
    task: str
    frequency: str
    frequency_value: int = 1
    last_pm_date: date | None = None
    next_due_date: date | None = None
    estimated_time_h: float | None = None
    priority: str = "Medium"
    active: bool = True
    sop_id: str | None = None
    added_unplanned: bool = False
    added_reason: str | None = None


class PMOut(PMCreate):
    pm_id: str
    id: int

    model_config = ConfigDict(from_attributes=True)


class WOCreate(BaseModel):
    work_order_id: str | None = None
    work_order_type: str
    equipment_id: str | None = None
    manual_equipment_code: str | None = None
    manual_equipment_name: str | None = None
    manual_plant_id: str | None = None
    manual_line_id: str | None = None
    component_id: str | None = None
    pm_id: str | None = None
    priority: str = "Medium"
    status: str = "Open"
    problem_description: str | None = None
    work_description: str | None = None
    planned_date: date | None = None
    assigned_technician_id: str | None = None


class WOUpdate(BaseModel):
    status: str | None = None
    priority: str | None = None
    assigned_technician_id: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    downtime_h: float | None = None
    labor_hours: float | None = None
    failure_mode: str | None = None
    failure_cause: str | None = None
    corrective_action: str | None = None
    result: str | None = None
    verification: str | None = None
    parts_used: str | None = None


class WOOut(WOCreate):
    id: int
    request_date: date
    start_time: datetime | None = None
    end_time: datetime | None = None
    downtime_h: float | None = None
    labor_hours: float | None = None
    failure_mode: str | None = None
    failure_cause: str | None = None
    corrective_action: str | None = None
    result: str | None = None
    verification: str | None = None
    parts_used: str | None = None
    closed_by: str | None = None
    closing_date: datetime | None = None
    created_by: str
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Daily Report
# ---------------------------------------------------------------------------

MAINTENANCE_TYPES = (
    "Preventive",
    "Corrective",
    "Routine",
    "Inspection",
)


class ReportItemCreate(BaseModel):
    equipment_id: str | None = None
    equipment_code: str | None = None
    equipment_name: str | None = None
    plant_id: str | None = None
    line_id: str | None = None
    is_manual_entry: bool = False
    component_id: str | None = None

    maintenance_type: str = "Corrective"

    maintenance_start: time | None = None
    maintenance_end: time | None = None

    # Downtime is tracked separately from technician maintenance time.
    downtime_start: time | None = None
    downtime_end: time | None = None
    downtime_h: float | None = None
    downtime_reason: str | None = None

    failure_reason: str | None = None
    action_taken: str | None = None

    # Text only for now; this is not the inventory system.
    spare_parts: str | None = None

    maintenance_completed: bool = False

    # Optional links to existing/planned work.
    pm_id: str | None = None
    wo_id: str | None = None


class DailyReportCreate(BaseModel):
    report_date: date
    shift: str | None = None
    shift_engineer: str | None = None
    general_notes: str | None = None
    items: list[ReportItemCreate] = Field(default_factory=list)

    # technician_id is intentionally NOT accepted from Flutter.
    # The API must obtain it from the authenticated user's account.


class DailyReportUpdate(BaseModel):
    report_date: date | None = None
    shift: str | None = None
    shift_engineer: str | None = None
    general_notes: str | None = None
    items: list[ReportItemCreate] | None = None


class ReportItemOut(ReportItemCreate):
    id: int

    model_config = ConfigDict(from_attributes=True)


class DailyReportOut(BaseModel):
    id: int
    report_id: str
    report_date: date
    technician_id: str

    work_order_id: str | None = None
    equipment_id: str | None = None

    work_summary: str | None = None
    finding: str | None = None
    action_taken: str | None = None
    general_notes: str | None = None
    equipment_status: str | None = None
    labor_hours: float | None = None

    status: str
    shift: str | None = None
    shift_engineer: str | None = None

    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None = None

    approved_at: datetime | None = None
    approved_by: str | None = None
    locked_at: datetime | None = None

    items: list[ReportItemOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class DailyReportSubmitOut(BaseModel):
    report_id: str
    status: str
    submitted_at: datetime


class DailyReportApproveOut(BaseModel):
    report_id: str
    status: str
    approved_by: str
    approved_at: datetime
    locked_at: datetime


class SOPCreate(BaseModel):
    equipment_id: str
    component_id: str | None = None
    title: str
    sop_type: str | None = None
    revision: str = "00"
    effective_date: date | None = None
    review_date: date | None = None
    prepared_by: str | None = None
    approved_by: str | None = None
    iso_classification: str | None = None
    status: str = "Draft"
    document_path: str | None = None
    notes: str | None = None


class ISOCreate(BaseModel):
    document_number: str
    document_title: str
    document_type: str | None = None
    iso_reference: str | None = None
    revision: str = "00"
    effective_date: date | None = None
    review_date: date | None = None
    prepared_by: str | None = None
    approved_by: str | None = None
    status: str = "Draft"
    notes: str | None = None
