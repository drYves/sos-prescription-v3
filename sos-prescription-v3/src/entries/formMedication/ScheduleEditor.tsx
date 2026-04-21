import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { FrequencyUnit, Schedule } from '../formTunnel/types';
import { clampInt, distributeTimes, fillArray, isTimeString, normalizeSchedule } from './schedule';
import { Button, Notice, Settings2Icon, TextInput, XIcon } from './shared';

export function ScheduleEditor({
  value,
  onChange,
}: {
  value?: Partial<Schedule>;
  onChange: (next: Schedule) => void;
}) {
  const normalized = useMemo(() => normalizeSchedule(value), [value]);

  useEffect(() => {
    const input = value as Partial<Schedule> | undefined;
    if (
      !input
      || typeof input !== 'object'
      || input.nb == null
      || input.freqUnit == null
      || input.durationVal == null
      || input.durationUnit == null
      || !Array.isArray(input.times)
      || !Array.isArray(input.doses)
      || input.start == null
      || input.end == null
    ) {
      onChange(normalized);
    }
  }, []);

  const count = normalized.nb;
  const freqUnit = normalized.freqUnit;
  const autoTimesEnabled = normalized.autoTimesEnabled !== false && freqUnit === 'jour';
  const startTime = normalized.start || '08:00';
  const endTime = normalized.end || '20:00';
  const autoDistribution = useMemo(
    () => (autoTimesEnabled ? distributeTimes(count, startTime, endTime) : null),
    [autoTimesEnabled, count, startTime, endTime],
  );
  const times = autoDistribution ? autoDistribution.times : fillArray(normalized.times, count, '');
  const doses = fillArray(normalized.doses, count, '1');
  const warnings = autoDistribution ? autoDistribution.warnings : [];
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const update = useCallback((patch: Partial<Schedule>) => {
    onChange({
      ...normalized,
      ...patch,
    });
  }, [normalized, onChange]);

  const updateCount = useCallback((raw: string) => {
    const nextCount = clampInt(raw, 1, freqUnit === 'jour' ? 6 : 12, 1);
    if (autoTimesEnabled) {
      const auto = distributeTimes(nextCount, startTime, endTime);
      onChange({
        ...normalized,
        nb: nextCount,
        start: auto.start,
        end: auto.end,
        times: auto.times,
        doses: fillArray(normalized.doses, nextCount, '1'),
        autoTimesEnabled: true,
      });
      return;
    }

    onChange({
      ...normalized,
      nb: nextCount,
      times: fillArray(normalized.times, nextCount, ''),
      doses: fillArray(normalized.doses, nextCount, '1'),
    });
  }, [autoTimesEnabled, endTime, freqUnit, normalized, onChange, startTime]);

  const updateFreqUnit = useCallback((nextFreqUnit: FrequencyUnit) => {
    const safeCount = clampInt(normalized.nb, 1, nextFreqUnit === 'jour' ? 6 : 12, 1);
    if (nextFreqUnit === 'jour') {
      const auto = distributeTimes(safeCount, normalized.start, normalized.end);
      onChange({
        ...normalized,
        nb: safeCount,
        freqUnit: nextFreqUnit,
        autoTimesEnabled: normalized.autoTimesEnabled !== false,
        start: auto.start,
        end: auto.end,
        times: normalized.autoTimesEnabled !== false ? auto.times : fillArray(normalized.times, safeCount, ''),
        doses: fillArray(normalized.doses, safeCount, '1'),
      });
      return;
    }

    onChange({
      ...normalized,
      nb: safeCount,
      freqUnit: nextFreqUnit,
      autoTimesEnabled: false,
      times: fillArray(normalized.times, safeCount, ''),
      doses: fillArray(normalized.doses, safeCount, '1'),
    });
  }, [normalized, onChange]);

  const enableAutomaticTimes = useCallback(() => {
    const auto = distributeTimes(normalized.nb, normalized.start, normalized.end);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const disableAutomaticTimes = useCallback(() => {
    onChange({
      ...normalized,
      autoTimesEnabled: false,
      times: fillArray(normalized.times, normalized.nb, ''),
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const updateAnchors = useCallback((nextStart: string, nextEnd: string) => {
    const safeStart = isTimeString(nextStart) ? nextStart : normalized.start;
    const safeEnd = isTimeString(nextEnd) ? nextEnd : normalized.end;
    const auto = distributeTimes(normalized.nb, safeStart, safeEnd);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
    });
  }, [normalized, onChange]);

  const updateTime = useCallback((index: number, nextTime: string) => {
    const nextTimes = fillArray(times, normalized.nb, '');
    nextTimes[index] = nextTime;
    onChange({
      ...normalized,
      autoTimesEnabled: false,
      times: nextTimes,
      start: nextTimes[0] || normalized.start,
      end: nextTimes[nextTimes.length - 1] || normalized.end,
    });
  }, [normalized, onChange, times]);

  const updateDose = useCallback((index: number, nextDose: string) => {
    const nextDoses = fillArray(doses, normalized.nb, '1');
    nextDoses[index] = nextDose;
    onChange({
      ...normalized,
      doses: nextDoses,
    });
  }, [doses, normalized, onChange]);

  const openAdvancedPlanning = useCallback(() => {
    setAdvancedOpen(true);
  }, []);

  return (
    <div className="sp-app-card sp-app-card--nested sp-app-schedule-editor">
      <div className="sp-app-grid sp-app-grid--two sp-app-schedule-editor__overview">
        <div className="sp-app-field">
          <label className="sp-app-field__label">Nombre de prises</label>
          <TextInput
            type="number"
            min={1}
            max={freqUnit === 'jour' ? 6 : 12}
            value={count}
            onChange={(event) => updateCount(event.target.value)}
          />
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Périodicité</label>
          <select
            className="sp-app-control sp-app-select"
            value={freqUnit}
            onChange={(event) => updateFreqUnit(event.target.value === 'semaine' ? 'semaine' : 'jour')}
          >
            <option value="jour">Par jour</option>
            <option value="semaine">Par semaine</option>
          </select>
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Durée</label>
          <TextInput
            type="number"
            min={1}
            max={3650}
            value={normalized.durationVal}
            onChange={(event) => update({ durationVal: clampInt(event.target.value, 1, 3650, 5) })}
          />
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Unité</label>
          <select
            className="sp-app-control sp-app-select"
            value={normalized.durationUnit}
            onChange={(event) => update({ durationUnit: event.target.value === 'mois' ? 'mois' : event.target.value === 'semaine' ? 'semaine' : 'jour' })}
          >
            <option value="jour">Jour(s)</option>
            <option value="semaine">Semaine(s)</option>
            <option value="mois">Mois</option>
          </select>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="sp-app-block">
          <Notice variant="warning">
            <ul className="sp-app-list">
              {warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <div className="sp-app-dose-list sp-app-dose-list--grouped">
        {Array.from({ length: count }).map((_, index) => {
          const isFirst = index === 0;
          const isLast = index === count - 1 && count > 1;
          const label = isFirst ? '1ère prise' : isLast ? 'Dernière prise' : `Prise ${index + 1}`;
          return (
            <div key={index} className="sp-app-dose-row">
              <div className="sp-app-dose-row__label">
                <span>{label}</span>
              </div>
              <TextInput
                type="time"
                step={300}
                value={times[index] || ''}
                onChange={(event) => updateTime(index, event.target.value)}
              />
              <TextInput
                type="text"
                placeholder="Dose ou quantité"
                value={doses[index] || '1'}
                onChange={(event) => updateDose(index, event.target.value)}
              />
            </div>
          );
        })}
      </div>

      {freqUnit === 'jour' ? (
        <div className="sp-app-schedule-editor__advanced" data-expanded={advancedOpen ? 'true' : 'false'}>
          {advancedOpen ? (
            <div className="sp-app-schedule sp-app-schedule--grouped sp-app-schedule--advanced">
              <div className="sp-app-schedule__header">
                <div className="sp-app-schedule__title">
                  <span>Réglages avancés de planification</span>
                </div>
                <div className="sp-app-schedule__actions">
                  {autoTimesEnabled ? (
                    <Button type="button" variant="secondary" className="sp-app-schedule__toggle-auto" onClick={disableAutomaticTimes}>
                      Passer en manuel
                    </Button>
                  ) : (
                    <Button type="button" variant="secondary" className="sp-app-schedule__toggle-auto" onClick={enableAutomaticTimes}>
                      Utiliser les horaires suggérés
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className="sp-app-schedule__close-button"
                    onClick={() => setAdvancedOpen(false)}
                  >
                    <XIcon className="sp-app-schedule-editor__close-icon" />
                    Fermer
                  </Button>
                </div>
              </div>

              <div className="sp-app-grid sp-app-grid--two sp-app-schedule__anchors">
                <div className="sp-app-field">
                  <label className="sp-app-field__label">1ère prise</label>
                  <TextInput
                    type="time"
                    step={300}
                    value={normalized.start}
                    onChange={(event) => updateAnchors(event.target.value, normalized.end)}
                    disabled={!autoTimesEnabled}
                  />
                </div>
                <div className="sp-app-field">
                  <label className="sp-app-field__label">Dernière prise</label>
                  <TextInput
                    type="time"
                    step={300}
                    value={normalized.end}
                    onChange={(event) => updateAnchors(normalized.start, event.target.value)}
                    disabled={!autoTimesEnabled}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="sp-app-schedule-editor__advanced-toggle">
              <Button type="button" variant="secondary" className="sp-app-schedule-editor__personalize-button" onClick={openAdvancedPlanning}>
                <Settings2Icon className="sp-app-schedule-editor__settings-icon" />
                Personnaliser
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
