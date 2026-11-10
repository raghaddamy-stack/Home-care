// NEWS2 (Royal College of Physicians, 2017) with the escalation rules from BRD §5.5.

export type Consciousness = 'A' | 'C' | 'V' | 'P' | 'U';

export interface Vitals {
  respRate: number;
  spo2: number;
  /** Scale 2 only for documented hypercapnic respiratory failure; set by a doctor. */
  spo2Scale?: 1 | 2;
  onOxygen: boolean;
  systolicBp: number;
  heartRate: number;
  consciousness: Consciousness;
  temperature: number;
}

export type RiskBand = 'LOW' | 'LOW_MEDIUM' | 'MEDIUM' | 'HIGH';

export interface News2Result {
  total: number;
  parts: Record<string, number>;
  anySingle3: boolean;
  band: RiskBand;
  action: string;
}

function respRate(v: number) {
  if (v <= 8) return 3;
  if (v <= 11) return 1;
  if (v <= 20) return 0;
  if (v <= 24) return 2;
  return 3;
}

function spo2Scale1(v: number) {
  if (v <= 91) return 3;
  if (v <= 93) return 2;
  if (v <= 95) return 1;
  return 0;
}

function spo2Scale2(v: number, onOxygen: boolean) {
  if (v <= 83) return 3;
  if (v <= 85) return 2;
  if (v <= 87) return 1;
  if (v <= 92) return 0;
  if (!onOxygen) return 0; // ≥93 on air
  if (v <= 94) return 1;
  if (v <= 96) return 2;
  return 3;
}

function systolic(v: number) {
  if (v <= 90) return 3;
  if (v <= 100) return 2;
  if (v <= 110) return 1;
  if (v <= 219) return 0;
  return 3;
}

function pulse(v: number) {
  if (v <= 40) return 3;
  if (v <= 50) return 1;
  if (v <= 90) return 0;
  if (v <= 110) return 1;
  if (v <= 130) return 2;
  return 3;
}

function temp(v: number) {
  if (v <= 35.0) return 3;
  if (v <= 36.0) return 1;
  if (v <= 38.0) return 0;
  if (v <= 39.0) return 1;
  return 2;
}

export function scoreNews2(v: Vitals): News2Result {
  const parts = {
    respRate: respRate(v.respRate),
    spo2: v.spo2Scale === 2 ? spo2Scale2(v.spo2, v.onOxygen) : spo2Scale1(v.spo2),
    oxygen: v.onOxygen ? 2 : 0,
    systolicBp: systolic(v.systolicBp),
    heartRate: pulse(v.heartRate),
    consciousness: v.consciousness === 'A' ? 0 : 3,
    temperature: temp(v.temperature),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const anySingle3 = Object.values(parts).some((p) => p === 3);

  let band: RiskBand;
  let action: string;
  if (total >= 7) {
    band = 'HIGH';
    action = 'Emergency: call ambulance, notify doctor and family, put episode on hold';
  } else if (total >= 5) {
    band = 'MEDIUM';
    action = 'Recheck in 15 min; if still >= 5 page on-call doctor (reply <= 15 min)';
  } else if (anySingle3) {
    band = 'LOW_MEDIUM';
    action = 'Single parameter scored 3: urgent doctor review';
  } else {
    band = 'LOW';
    action = 'Routine monitoring';
  }
  return { total, parts, anySingle3, band, action };
}

/** Whether a reading should open an escalation record immediately. */
export function needsEscalation(r: News2Result): boolean {
  return r.band !== 'LOW';
}
