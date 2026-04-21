import React from 'react';

export type RequestListPanelRow = {
  id: number;
  selected: boolean;
  statusLabel: string;
  statusTone: 'success' | 'warning' | 'neutral';
  title: string;
  createdAtLabel: string;
};

type RequestListPanelProps = {
  rows: RequestListPanelRow[];
  listLoading: boolean;
  hasRows: boolean;
  onSelectRequest: (id: number) => void;
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function RequestListPanel({
  rows,
  listLoading,
  hasRows,
  onSelectRequest,
}: RequestListPanelProps) {
  return (
    <aside className="sp-console-grid__sidebar sp-patient-console__sidebar">
      <div className="sp-panel sp-patient-console__sidebar-panel">
        <div className="sp-panel__header">
          <div className="sp-panel__title">Mes demandes</div>
        </div>
        <div className="sp-panel__body">
          {!hasRows ? (
            <div className="sp-panel__empty">{listLoading ? 'Chargement…' : 'Aucune demande.'}</div>
          ) : (
            <div className="sp-list sp-patient-console__request-list">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={cx('sp-list-item', 'sp-list-item--button', 'sp-list-item--request', row.selected && 'is-selected')}
                  onClick={() => onSelectRequest(row.id)}
                >
                  <div className="sp-list-item__status-row">
                    <span className={cx('sp-status-dot', `is-${row.statusTone}`)} aria-hidden="true" />
                    <div className="sp-list-item__meta">{row.statusLabel}</div>
                  </div>
                  <div className="sp-list-item__title">{row.title}</div>
                  <div className="sp-list-item__submeta">{row.createdAtLabel}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
