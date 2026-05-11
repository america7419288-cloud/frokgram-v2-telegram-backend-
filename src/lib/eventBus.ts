import { EventEmitter } from "events";

class EventBusEmitter extends EventEmitter {
  async emit(event: string | symbol, ...args: any[]): Promise<boolean> {
    return super.emit(event, ...args);
  }
}

export const EventBus = new EventBusEmitter();
