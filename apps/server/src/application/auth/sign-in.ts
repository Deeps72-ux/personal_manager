import type { AuthResponse, Credentials } from "@pm/shared";
import { InvalidCredentialsError } from "../../domain/errors.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import type { Clock, PasswordHasher, TokenService } from "../../ports/services.ts";
import { openSession, type SessionPolicy } from "./sessions.ts";

interface SignInDeps {
  uow: UnitOfWork;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  policy: SessionPolicy;
}

export class SignIn {
  /** Hash of a random password, verified when the username doesn't exist. */
  private dummyHash: Promise<string> | null = null;
  private readonly deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.deps = deps;
  }

  async execute(credentials: Credentials): Promise<AuthResponse> {
    const user = await this.deps.uow.run((repos) => repos.users.findByUsername(credentials.username));

    // Always run one password verification, even for unknown usernames, so
    // response time does not reveal which usernames exist.
    this.dummyHash ??= this.deps.hasher.hash(`dummy-${Math.random()}`);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const ok = await this.deps.hasher.verify(hash, credentials.password);
    if (!user || !ok) throw new InvalidCredentialsError();

    return this.deps.uow.run((repos) => openSession(repos, user, this.deps));
  }
}
