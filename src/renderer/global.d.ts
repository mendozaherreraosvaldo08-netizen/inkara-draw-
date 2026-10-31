import type { TrazoApi } from '../shared/api';

declare global {
  interface Window {
    /** Puente del preload. No existe al abrir la interfaz fuera de Electron (pruebas en navegador). */
    trazo?: TrazoApi;
  }
}

export {};
