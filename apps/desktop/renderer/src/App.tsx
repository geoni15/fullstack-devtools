import { BottomPanel } from './components/BottomPanel';
import { EditorArea } from './components/EditorArea';
import { Explorer } from './components/Explorer';
import { InspectorPanel } from './components/InspectorPanel';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';

export function App() {
  return (
    <div className="app-shell">
      <TitleBar />
      <main className="app-main">
        <Explorer />
        <EditorArea />
        <InspectorPanel />
      </main>
      <BottomPanel />
      <StatusBar />
    </div>
  );
}
