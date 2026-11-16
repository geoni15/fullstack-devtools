import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  type FlowJsonState,
  type FlowMapState,
  type FlowRequestState,
} from '@bdt/protocol';
import {
  applyFlowJsonState,
  applyFlowMapState,
  applyFlowRequestState,
  handleMapCloseBlocked,
  initFlowMap,
  setMapShiftHeld,
} from './flow-map';

window.addEventListener('DOMContentLoaded', () => {
  initFlowMap();
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.mapData, (_event, state: FlowMapState) => {
    applyFlowMapState(state);
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.jsonData, (_event, state: FlowJsonState) => {
    applyFlowJsonState(state);
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.requestData, (_event, state: FlowRequestState) => {
    applyFlowRequestState(state);
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.shift, (_event, held: unknown) => {
    setMapShiftHeld(held === true);
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.mapCloseBlocked, (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return;
    handleMapCloseBlocked(paths.filter((path): path is string => typeof path === 'string'));
  });
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.ready);
});
