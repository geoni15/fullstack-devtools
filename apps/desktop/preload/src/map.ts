import { ipcRenderer } from 'electron';
import { BROWSER_PANEL_CHANNELS, type FlowMapState } from '@bdt/protocol';
import { applyFlowMapState, initFlowMap, setMapShiftHeld } from './flow-map';

window.addEventListener('DOMContentLoaded', () => {
  initFlowMap();
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.mapData, (_event, state: FlowMapState) => {
    applyFlowMapState(state);
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.shift, (_event, held: unknown) => {
    setMapShiftHeld(held === true);
  });
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.ready);
});
