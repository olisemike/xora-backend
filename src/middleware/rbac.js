// ============================================
// ROLE-BASED ACCESS CONTROL (RBAC) MIDDLEWARE
// ============================================

import { errorResponse } from '../utils/helpers.js';

/**
 * Admin roles with permission hierarchies
 * Higher roles inherit lower role permissions
 */
export const ADMIN_ROLES = {
  SUPER_ADMIN: {
    name: 'super_admin',
    level: 4,
    description: 'Full system access',
    permissions: [
      'view_reports',
      'resolve_reports',
      'ban_users',
      'verify_users',
      'delete_posts',
      'view_analytics',
      'export_data',
      'import_data',
      'manage_admins', // Can create/delete other admins
      'manage_roles',
      'system_settings',
      'view_all_user_data',
      'audit_logs'
    ]
  },
  ADMIN: {
    name: 'admin',
    level: 3,
    description: 'Full moderation access, cannot manage admins',
    permissions: [
      'view_reports',
      'resolve_reports',
      'ban_users',
      'verify_users',
      'delete_posts',
      'view_analytics',
      'export_data',
      'view_all_user_data',
      'audit_logs'
    ]
  },
  MODERATOR: {
    name: 'moderator',
    level: 2,
    description: 'Content moderation only',
    permissions: [
      'view_reports',
      'resolve_reports',
      'delete_posts',
      'view_analytics' // Limited analytics
    ]
  },
  SUPPORT: {
    name: 'support',
    level: 1,
    description: 'User support only',
    permissions: [
      'view_reports', // Read only
      'verify_users',
      'view_all_user_data'
    ]
  }
};

/**
 * Actions that require minimum role levels
 * Maps action to minimum required role level
 */
export const ROLE_REQUIREMENTS = {
  // User management
  'ban_users': ADMIN_ROLES.ADMIN.level,
  'unban_users': ADMIN_ROLES.ADMIN.level,
  'verify_users': ADMIN_ROLES.SUPPORT.level,
  
  // Admin management (super admin only)
  'create_admin': ADMIN_ROLES.SUPER_ADMIN.level,
  'delete_admin': ADMIN_ROLES.SUPER_ADMIN.level,
  'modify_admin': ADMIN_ROLES.SUPER_ADMIN.level,
  'change_admin_role': ADMIN_ROLES.SUPER_ADMIN.level,
  'manage_permissions': ADMIN_ROLES.SUPER_ADMIN.level,
  
  // Content moderation
  'delete_posts': ADMIN_ROLES.MODERATOR.level,
  'delete_content': ADMIN_ROLES.MODERATOR.level,
  'resolve_reports': ADMIN_ROLES.MODERATOR.level,
  
  // Data access
  'export_data': ADMIN_ROLES.ADMIN.level,
  'import_data': ADMIN_ROLES.SUPER_ADMIN.level, // Extra restrictive
  'view_all_user_data': ADMIN_ROLES.SUPPORT.level,
  'view_analytics': ADMIN_ROLES.MODERATOR.level,
  'view_system_analytics': ADMIN_ROLES.ADMIN.level,
  'audit_logs': ADMIN_ROLES.ADMIN.level
};

/**
 * RBAC middleware to enforce role-based access control
 * 
 * Usage:
 *   const rbacError = rbacMiddleware(adminResult, requiredRole, action);
 *   if (rbacError) return rbacError;
 * 
 * @param {object} adminResult - Result from adminMiddleware with role and permissions
 * @param {string} requiredRole - Role name (super_admin, admin, moderator, support)
 * @param {string} action - Action being performed (for logging/audit)
 * @returns {null|Response} - Returns error response if access denied
 */
export function rbacMiddleware(adminResult, requiredRole, action) {
  if (!adminResult || !adminResult.role) {
    return errorResponse('Admin verification failed', 403);
  }

  // Get role configuration
  const roleConfig = Object.values(ADMIN_ROLES).find(r => r.name === adminResult.role);
  if (!roleConfig) {
    return errorResponse('Invalid admin role', 403);
  }

  // Get required role level
  const requiredRoleConfig = Object.values(ADMIN_ROLES).find(r => r.name === requiredRole);
  if (!requiredRoleConfig) {
    console.error(`[RBAC] Invalid required role: ${requiredRole}`);
    return errorResponse('Configuration error', 500);
  }

  // Compare role levels (higher or equal level has access)
  if (roleConfig.level < requiredRoleConfig.level) {
    console.warn(
      `[RBAC] Access denied - Role ${adminResult.role} (level ${roleConfig.level}) ` +
      `cannot perform action "${action}" (requires ${requiredRole}, level ${requiredRoleConfig.level})`
    );

    return errorResponse(
      `You do not have permission to ${action}. This action requires ${requiredRole} or higher.`,
      403,
      { requiredRole, currentRole: adminResult.role, action }
    );
  }

  console.log(`[RBAC] Access granted - ${adminResult.role} performing ${action}`);
  return null; // Access granted
}

/**
 * Check specific permission
 * Usage:
 *   const permError = checkPermission(adminResult, 'ban_users');
 * 
 * @param {object} adminResult - Result from adminMiddleware
 * @param {string} permission - Permission name
 * @returns {null|Response} - Returns error if permission denied
 */
export function checkPermission(adminResult, permission) {
  if (!adminResult || !adminResult.permissions) {
    return errorResponse('Admin verification failed', 403);
  }

  // Check if has 'all' wildcard or specific permission
  if (Array.isArray(adminResult.permissions)) {
    if (adminResult.permissions.includes('all') || adminResult.permissions.includes(permission)) {
      return null; // Permission granted
    }
  }

  console.warn(`[RBAC] Permission denied for action: ${permission}`);
  return errorResponse(`You do not have permission for: ${permission}`, 403, { permission });
}

/**
 * Helper to get role config
 */
export function getRoleConfig(roleName) {
  return Object.values(ADMIN_ROLES).find(r => r.name === roleName);
}

/**
 * Helper to get all permissions for a role
 */
export function getRolePermissions(roleName) {
  const role = getRoleConfig(roleName);
  return role ? role.permissions : [];
}

/**
 * List all available roles with their permissions
 */
export function listRoles() {
  return Object.values(ADMIN_ROLES).map(role => ({
    name: role.name,
    level: role.level,
    description: role.description,
    permissions: role.permissions
  }));
}

/**
 * Helper to determine if an admin can manage another admin
 * Only super admins can create/delete other admins
 * Admins can only manage users below their role level
 */
export function canManageAdmin(sourceAdminRole, targetAdminRole) {
  const source = getRoleConfig(sourceAdminRole);
  const target = getRoleConfig(targetAdminRole);

  if (!source || !target) return false;

  // Super admin can manage anyone
  if (source.name === 'super_admin') return true;

  // Others cannot manage admins at their level or above
  return false;
}
