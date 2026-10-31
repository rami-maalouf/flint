export type AuthorizationEpoch = Readonly<{
  epoch: string;
  mode: 'normal' | 'degraded_read';
}>;

export type AuthorizationEpochSource = Readonly<{
  current(): Promise<AuthorizationEpoch>;
}>;
import { randomUUID } from 'node:crypto';

import { FileRestoreLatch, type LatchOptions } from '../operations/recovery-head';


export class FileAuthorizationEpoch implements AuthorizationEpochSource {
  private readonly latch: FileRestoreLatch;
  private readonly fallback: AuthorizationEpoch = Object.freeze({ epoch: randomUUID(), mode: 'degraded_read' });

  constructor(options: LatchOptions) { this.latch = new FileRestoreLatch(options); }

  async current(): Promise<AuthorizationEpoch> {
    const marker = this.latch.readGeneration();
    return marker ? Object.freeze({ epoch: marker.generation, mode: marker.restored ? 'degraded_read' : 'normal' }) : this.fallback;
  }
}
