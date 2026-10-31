const INSPECTOR_TABS = [
  'Overview',
  'Dependencies',
  'Execution',
  'Database',
  'Source',
  'Performance',
] as const;

export function InspectorPanel() {
  return (
    <aside className="panel inspector">
      <div className="panel-head">Inspector</div>

      <div className="inspector-tabs">
        {INSPECTOR_TABS.map((tab, index) => (
          <span key={tab} className={`inspector-tab${index === 0 ? ' is-active' : ''}`}>
            {tab}
          </span>
        ))}
      </div>

      <div className="inspector-body">
        <p className="empty-title">Sin elemento seleccionado</p>
        <p className="empty-text">
          El inspector por cursor llega en F2. Las pestañas de dependencias, ejecución y base de
          datos se rellenarán en F3–F5.
        </p>
        <span className="level-note">Niveles activos: —</span>
      </div>
    </aside>
  );
}
