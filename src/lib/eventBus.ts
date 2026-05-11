import { EventEmitter } from "events";

const emitter = new EventEmitter();

export const EventBus = {
  emit: async (event: string | symbol, ...args: any[]): Promise<void> => {
    emitter.emit(event, ...args);
  },
  on: (event: string | symbol, listener: (...args: any[]) => void) => {
    emitter.on(event, listener);
  },
  once: (event: string | symbol, listener: (...args: any[]) => void) => {
    emitter.once(event, listener);
  },
  removeListener: (event: string | symbol, listener: (...args: any[]) => void) => {
    emitter.removeListener(event, listener);
  }
};
