'use strict';
// Roles from the governance documents. '*' = every permission.
const ROLES = {
  admin:      { label: 'مدير النظام',     perms: ['*'] },
  executive:  { label: 'صاحب قرار',      perms: ['requests.viewAll', 'audit.view', 'decisions.create', 'decisions.viewAll'] },
  manager:    { label: 'مدير قطاع',      perms: ['requests.viewAll', 'decisions.create', 'decisions.viewAll'] },
  analyst:    { label: 'محلل بيانات',    perms: ['requests.viewAll', 'requests.manage'] },
  consultant: { label: 'مستشار',         perms: ['requests.viewAll', 'requests.manage'] },
  governance: { label: 'حوكمة البيانات', perms: ['requests.viewAll', 'audit.view', 'audit.verify'] },
  auditor:    { label: 'مدقق',           perms: ['requests.viewAll', 'audit.view', 'audit.verify', 'decisions.viewAll'] },
  client:     { label: 'عميل',           perms: [] }
};

function can(user, perm) {
  if (!user) return false;
  const r = ROLES[user.role];
  if (!r) return false;
  return r.perms.includes('*') || r.perms.includes(perm);
}

function permsOf(role) {
  const r = ROLES[role];
  if (!r) return [];
  if (r.perms.includes('*')) return ['*'];
  return r.perms.slice();
}

module.exports = { ROLES, can, permsOf };
