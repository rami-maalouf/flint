import type { Session } from 'snapback4/auth';
import type { Scope } from '../tools/contracts';

// only the provider constructs this contract from its admitted browser/grant binding.
// workers must await assertActive before protected work and again before delivery.
export type AuthContext = {
  accountId: string;
  clientId: string;
  grantId: string;
  principal: string;
  scopes: readonly Scope[];
  backendUrl: string;
  session: Session;
  assertActive: () => Promise<void>;
};
