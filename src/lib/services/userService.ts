import type { UserRepository } from '@/lib/repositories';

export class UserService {
  constructor(private readonly userRepo: UserRepository) {}

  list() {
    return this.userRepo.findAll();
  }
}
