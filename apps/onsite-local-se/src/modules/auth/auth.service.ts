import { signToken, type Role } from '../../auth.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { hashPassword, verifyPassword } from '../../passwords.js';

interface UserRow {
  user_id: string;
  password_hash: string;
  role: Role;
  country: string;
  store_id: string | null;
  customer_id: string | null;
}

export class AuthService {
  /** Compared against when the user is unknown, so that both cases take the same time. */
  private readonly decoyHash = hashPassword('decoy-for-unknown-users');

  constructor(
    private readonly pool: Db,
    private readonly config: Config,
  ) {}

  async login(username: string, password: string) {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE user_id = $1', [username]);
    const user = rows[0];
    const matches = verifyPassword(password, user?.password_hash ?? this.decoyHash);
    if (!user || !matches) throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password');
    const access_token = signToken(
      {
        sub: user.user_id,
        role: user.role,
        country: user.country,
        ...(user.store_id ? { store_id: user.store_id } : {}),
        ...(user.customer_id ? { customer_id: user.customer_id } : {}),
      },
      this.config.jwtSecret,
      this.config.jwtTtlSeconds,
    );
    return {
      access_token,
      token_type: 'Bearer' as const,
      expires_in: this.config.jwtTtlSeconds,
      user_id: user.user_id,
      role: user.role,
      country: user.country,
      store_id: user.store_id,
      customer_id: user.customer_id,
    };
  }
}
