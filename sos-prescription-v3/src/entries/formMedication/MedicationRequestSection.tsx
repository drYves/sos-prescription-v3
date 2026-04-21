import React from 'react';
import type { FlowType, MedicationItem, MedicationSearchResult } from '../formTunnel/types';
import { MedicationSearch } from './MedicationSearch';
import { ScheduleEditor } from './ScheduleEditor';
import { Button } from './shared';

type MedicationRequestSectionProps = {
  flow: FlowType;
  items: MedicationItem[];
  rejectedFiles: File[];
  onAddMedication: (item: MedicationSearchResult) => void;
  onUpdateMedication: (index: number, patch: Partial<MedicationItem>) => void;
  onRemoveMedication: (index: number) => void;
};

export function MedicationRequestSection({
  flow,
  items,
  rejectedFiles,
  onAddMedication,
  onUpdateMedication,
  onRemoveMedication,
}: MedicationRequestSectionProps) {
  const showMedicationFallback = flow === 'ro_proof' && rejectedFiles.length > 0;
  const showMedicationSearch = flow === 'depannage_no_proof'
    || showMedicationFallback;
  const showMedicationSection = flow === 'depannage_no_proof'
    || items.length > 0
    || showMedicationFallback;
  const medicationSectionHint = flow === 'ro_proof' && !showMedicationSearch
    ? 'Vérifiez le traitement détecté puis ajustez la posologie si nécessaire.'
    : 'Ajoutez chaque médicament puis ajustez la posologie si nécessaire.';

  if (!showMedicationSection) {
    return null;
  }

  return (
    <section className="sp-app-card sp-app-card--medication-request">
      <div className="sp-app-section__header">
        <div>
          <h2 className="sp-app-section__title">Traitement demandé</h2>
          <p className="sp-app-section__hint">
            {medicationSectionHint}
          </p>
        </div>
      </div>

      {showMedicationSearch ? (
        <div className="sp-app-field sp-app-field--search">
          <label className="sp-app-field__label">Médicament concerné</label>
          <MedicationSearch onSelect={onAddMedication} />
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="sp-app-medication-list">
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`} className="sp-app-medication-card sp-app-medication-card--stacked">
              <div className="sp-app-medication-card__head">
                <div className="sp-app-medication-card__content">
                  <div className="sp-app-medication-card__title">{item.label}</div>
                  <div className="sp-app-medication-card__meta">
                    {item.cis ? `CIS ${item.cis}` : ''}
                    {item.cip13 ? ` • CIP13 ${item.cip13}` : ''}
                  </div>
                </div>

                <Button type="button" variant="secondary" onClick={() => onRemoveMedication(index)}>
                  Retirer
                </Button>
              </div>

              <div className="sp-app-block">
                <div className="sp-app-field__label">Posologie</div>
                <ScheduleEditor
                  value={item.schedule || {}}
                  onChange={(nextSchedule) => {
                    onUpdateMedication(index, { schedule: nextSchedule });
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="sp-app-empty">Aucun médicament ajouté pour le moment.</div>
      )}
    </section>
  );
}
