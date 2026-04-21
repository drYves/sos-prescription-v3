import type { MedicationItem, MedicationSearchResult } from '../formTunnel/types';
import { normalizeSchedule } from './schedule';

export function buildMedicationItemFromSearchResult(medication: MedicationSearchResult): MedicationItem {
  return {
    cis: medication.cis,
    cip13: medication.cip13 || null,
    label: medication.label,
    schedule: normalizeSchedule({
      nb: 1,
      freqUnit: 'jour',
      durationVal: 5,
      durationUnit: 'jour',
      times: ['08:00'],
      doses: ['1'],
      note: '',
      autoTimesEnabled: true,
      start: '08:00',
      end: '20:00',
    }),
  };
}
