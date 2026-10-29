import api from './api';

export const authService = {
  loginEmail: (email, password) =>
    api.post('/api/v1/auth/login', { email, password }).then((r) => r.data),

  requestOtp: (phone) =>
    api.post('/api/v1/auth/otp/request', { phone }).then((r) => r.data),

  verifyOtp: (phone, otp) =>
    api.post('/api/v1/auth/otp/verify', { phone, otp }).then((r) => r.data),

  me: () =>
    api.get('/api/v1/auth/me').then((r) => r.data),

  getProfile: () =>
    api.get('/api/v1/auth/profile').then((r) => r.data),

  updateProfile: (payload) =>
    api.patch('/api/v1/auth/profile', payload).then((r) => r.data),

  changePassword: (currentPassword, newPassword) =>
    api.post('/api/v1/auth/change-password', { currentPassword, newPassword }).then((r) => r.data),

  forgotPassword: (email) =>
    api.post('/api/v1/auth/forgot-password', { email }).then((r) => r.data),

  resetPassword: ({ email, code, newPassword }) =>
    api.post('/api/v1/auth/reset-password', { email, code, newPassword }).then((r) => r.data),

  logout: () =>
    api.post('/api/v1/auth/logout').then((r) => r.data),
};

