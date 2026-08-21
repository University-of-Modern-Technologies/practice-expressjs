export interface UserRoleDto {
  id: string;
  name: string;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  roles: UserRoleDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListResult {
  readonly items: readonly UserDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface UserSessionDto {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserData {
  email: string;
  name: string;
  password: string;
  roleIds: string[];
}

export interface UpdateUserData {
  email?: string;
  name?: string;
  password?: string;
  roleIds?: string[];
}
