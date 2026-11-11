import { Db } from './db.js';

/** Reference data: services, cash + insurer prices, zones, staff. Prices in fils. */
export function seed(db: Db) {
  // Demo warehouse for the MOCK stock provider (idempotent).
  for (const [m, q] of [['MAT-O2-CONC', 3], ['MAT-BED-ELEC', 2], ['MAT-WHEELCHAIR', 5], ['MAT-MED-PACK', 40], ['MAT-LAB-KIT', 100]] as const) {
    db.run('INSERT OR IGNORE INTO stock_mock (material, available) VALUES (?, ?)', m, q);
  }
  if (db.get('SELECT 1 FROM services LIMIT 1')) return;
  db.tx(() => {
    for (const z of ['Amman West', 'Amman East', 'Zarqa', 'Irbid']) db.insert('zones', { name: z });

    const services: [string, string, string, string, string, string, number, number, number][] = [
      // code, ar, en, line, unit, department, preapproval, prescription, cash price
      ['LAB-CBC', 'تعداد دم كامل', 'Complete blood count', 'LAB', 'TEST', 'LAB', 0, 0, 8_000],
      ['LAB-HBA1C', 'السكر التراكمي', 'HbA1c', 'LAB', 'TEST', 'LAB', 0, 0, 12_000],
      ['LAB-PANEL', 'فحوصات شاملة', 'Comprehensive panel', 'LAB', 'TEST', 'LAB', 0, 0, 45_000],
      ['IMG-XRAY', 'صورة أشعة متنقلة', 'Portable X-ray', 'IMG', 'TEST', 'RADIOLOGY', 1, 1, 60_000],
      ['IMG-US', 'ألتراساوند منزلي', 'Home ultrasound', 'IMG', 'TEST', 'RADIOLOGY', 1, 1, 70_000],
      ['DEV-BED', 'تخت طبي كهربائي', 'Electric medical bed', 'DEV', 'DAY', 'EQUIPMENT', 1, 0, 5_000],
      ['DEV-O2', 'مكثّف أكسجين', 'Oxygen concentrator', 'DEV', 'DAY', 'EQUIPMENT', 1, 1, 7_000],
      ['DEV-WCHAIR', 'كرسي متحرك', 'Wheelchair', 'DEV', 'DAY', 'EQUIPMENT', 0, 0, 2_000],
      ['DOC-VISIT', 'زيارة طبيب', 'Doctor home visit', 'DOC', 'VISIT', 'CLINICAL', 0, 0, 35_000],
      ['NRS-VISIT', 'زيارة تمريض', 'Nursing visit', 'NRS', 'VISIT', 'CLINICAL', 0, 0, 20_000],
      ['NRS-HOUR', 'ساعة تمريض', 'Nursing hour (shift)', 'NRS', 'HOUR', 'CLINICAL', 1, 0, 6_000],
      ['PHA-DELIVERY', 'توصيل أدوية', 'Medication delivery', 'NRS', 'ITEM', 'PHARMACY', 0, 1, 3_000],
    ];
    for (const [code, ar, en, line, unit, dept, pre, rx, price] of services) {
      db.insert('services', { code, name_ar: ar, name_en: en, line, unit, department: dept, requires_preapproval: pre, requires_prescription: rx });
      db.insert('price_items', { service_code: code, unit_price: price });
    }

    db.insert('payers', { name: 'Self pay', type: 'SELF' });
    const ins = db.insert('payers', { name: 'Demo Insurance Co.', type: 'INSURER' });
    for (const [code, price] of [['LAB-CBC', 7_000], ['NRS-HOUR', 5_500], ['DOC-VISIT', 30_000], ['IMG-XRAY', 55_000]] as const) {
      db.insert('price_items', { payer_id: ins, service_code: code, unit_price: price });
    }

    const staff: [string, string, string, number][] = [
      ['Admin', 'ADMIN', 'M', 1],
      ['Lina (call center)', 'AGENT', 'F', 1],
      ['Omar (coordinator)', 'COORDINATOR', 'M', 1],
      ['Dr. Sami', 'DOCTOR', 'M', 1],
      ['Rana (RN)', 'NURSE', 'F', 1],
      ['Hadi (RN)', 'NURSE', 'M', 1],
      ['Maya (RN)', 'NURSE', 'F', 2],
      ['Yousef (lab tech)', 'LAB_TECH', 'M', 1],
      ['Nour (radiographer)', 'RADIOGRAPHER', 'F', 1],
      ['Khaled (driver)', 'DRIVER', 'M', 1],
      ['Huda (finance)', 'FINANCE', 'F', 1],
      ['Salma (supervisor)', 'SUPERVISOR', 'F', 1],
      ['Rami (pharmacist)', 'PHARMACIST', 'M', 1],
    ];
    for (const [name, role, gender, zone] of staff) db.insert('staff', { name, role, gender, zone_id: zone, licence_expiry: '2028-12-31' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new Db(process.env.DB_PATH ?? 'homecare.db');
  seed(db);
  console.log('Seeded', db.get('SELECT COUNT(*) AS n FROM services'), 'services');
}
