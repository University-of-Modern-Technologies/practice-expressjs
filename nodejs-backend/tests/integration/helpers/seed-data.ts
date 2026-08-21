export const seed = {
  password: 'LocalTrainingOnly!2026',
  users: {
    admin: {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'admin@crm-training.example',
    },
    manager: {
      id: '10000000-0000-4000-8000-000000000002',
      email: 'manager@crm-training.example',
    },
    viewer: {
      id: '10000000-0000-4000-8000-000000000003',
      email: 'viewer@crm-training.example',
    },
  },
  contacts: {
    manager: '20000000-0000-4000-8000-000000000001',
    viewer: '20000000-0000-4000-8000-000000000003',
  },
  deals: {
    managerProposal: '30000000-0000-4000-8000-000000000002',
    viewer: '30000000-0000-4000-8000-000000000003',
  },
} as const;
