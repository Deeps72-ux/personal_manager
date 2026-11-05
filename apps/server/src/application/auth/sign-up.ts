import type { AuthResponse, Credentials } from "@pm/shared";
import { SignUpDisabledError, UsernameTakenError } from "../../domain/errors.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import type { Clock, IdGenerator, PasswordHasher, TokenService } from "../../ports/services.ts";
import { openSession, type SessionPolicy } from "./sessions.ts";

interface SignUpDeps {
  uow: UnitOfWork;
  hasher: PasswordHasher;
  ids: IdGenerator;
  tokens: TokenService;
  clock: Clock;
  policy: SessionPolicy;
  allowSignUp: boolean;
}

export class SignUp {
  private readonly deps: SignUpDeps;

  constructor(deps: SignUpDeps) {
    this.deps = deps;
  }

  /** `credentials` must already be validated/normalized (CredentialsSchema). */
  async execute(credentials: Credentials): Promise<AuthResponse> {
    if (!this.deps.allowSignUp) throw new SignUpDisabledError();

    // Hash OUTSIDE the transaction: it is slow and needs no DB.
    const passwordHash = await this.deps.hasher.hash(credentials.password);

    return this.deps.uow.run(async (repos) => {
      if (await repos.users.findByUsername(credentials.username)) throw new UsernameTakenError();
      const user = {
        id: this.deps.ids.newId(),
        username: credentials.username,
        passwordHash,
        purgedBefore: null,
      };
      await repos.users.insert(user);
      return openSession(repos, user, this.deps);
    });
  }
}
