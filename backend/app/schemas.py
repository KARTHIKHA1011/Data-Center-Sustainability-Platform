from pydantic import BaseModel, Field, EmailStr
from typing import Optional
from datetime import datetime


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    name: str
    role: str


class UserOut(BaseModel):
    id: int
    employee_id: Optional[str] = None
    name: str
    email: str
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# User management schemas (infra manager only)
# ---------------------------------------------------------------------------

VALID_ROLES = {"infrastructure_manager", "sustainability_manager", "operations_engineer"}


class UserCreateIn(BaseModel):
    employee_id: Optional[str] = None
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=6, max_length=128)
    role: str
    is_active: bool = True

    @classmethod
    def __get_validators__(cls):
        yield cls.validate_role

    def validate_role(self) -> "UserCreateIn":
        if self.role not in VALID_ROLES:
            raise ValueError(f"role must be one of: {', '.join(sorted(VALID_ROLES))}")
        return self


class UserUpdateIn(BaseModel):
    employee_id: Optional[str] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    password: Optional[str] = Field(default=None, min_length=6, max_length=128)
    role: Optional[str] = None
    is_active: Optional[bool] = None


class ServerTelemetryIn(BaseModel):
    server_id: str
    cpu_utilization: float = Field(ge=0, le=100)
    memory_utilization: float = Field(ge=0, le=100)
    network_throughput_gbps: float = Field(ge=0)
    workload_intensity: float = Field(ge=0, le=1)


class PowerTelemetryIn(BaseModel):
    server_id: str
    it_power_kw: float = Field(ge=0)
    facility_power_kw: float = Field(ge=0)


class CoolingTelemetryIn(BaseModel):
    server_id: str
    inlet_temperature_c: float
    cooling_efficiency: float = Field(ge=0, le=1)
    cooling_type: str = "Air"


class StorageTelemetryIn(BaseModel):
    server_id: str
    total_storage_gb: float = Field(gt=0)
    used_storage_gb: float = Field(ge=0)
    duplicate_data_gb: float = Field(ge=0)
    last_accessed_days_ago: int = Field(ge=0)
    storage_type: str = "SSD"


class ServerRegisterIn(BaseModel):
    server_id: str
    server_type: str = "Compute"
    cooling_type: str = "Air"
    datacenter_region: str = "APAC"

class OperatorActionIn(BaseModel):
    action: str
    notes: Optional[str] = None
    target_server_id: Optional[str] = None
    snooze_hours: Optional[float] = Field(default=24, gt=0, le=24 * 30)


class PreferencesIn(BaseModel):
    energy_weight: float = Field(ge=0, le=10)
    cost_weight: float = Field(ge=0, le=10)
    carbon_weight: float = Field(ge=0, le=10)
    water_weight: float = Field(ge=0, le=10)
    risk_weight: float = Field(ge=0, le=10)

class SiteSettingsIn(BaseModel):
    """Site settings behind every carbon figure and the compliance report.

    installed_it_capacity_kw, renewable_energy_factor and energy_reuse_factor
    are operator-declared values GreenOps cannot derive from telemetry. Send
    null to clear one, which makes the matching indicator report as missing.
    """
    grid_emission_factor_kg_per_kwh: float = Field(gt=0, le=2)
    emission_factor_source: str = Field(min_length=1, max_length=300)
    installed_it_capacity_kw: Optional[float] = Field(default=None, gt=0, le=1_000_000)
    renewable_energy_factor: Optional[float] = Field(default=None, ge=0, le=1)
    energy_reuse_factor: Optional[float] = Field(default=None, ge=0, le=1)
    telemetry_simulated: bool = True
