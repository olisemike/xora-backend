/**
 * useLogin Hook
 * Handles login with IP pinning, 2FA, and device verification
 * Works for both Web and Mobile
 */

import { useState } from 'react';

export const useLogin = (apiUrl) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [requires2FA, setRequires2FA] = useState(false);
  const [requiresDeviceVerification, setRequiresDeviceVerification] = useState(false);
  const [tempToken, setTempToken] = useState('');

  /**
   * Login user
   */
  const loginUser = async (email, password) => {
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emailOrUsername: email,
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setFailedAttempts((prev) => prev + 1);
        setError(data.error?.message || 'Invalid credentials');
        setLoading(false);
        return {
          success: false,
          message: data.error?.message || 'Invalid credentials',
        };
      }

      // Check if 2FA is required
      if (data.data?.requires2FA) {
        setRequires2FA(true);
        setTempToken(data.data.tempToken);
        setFailedAttempts(0);
        setLoading(false);
        return {
          success: false,
          requires2FA: true,
          tempToken: data.data.tempToken,
          message: 'Please enter your 2FA code',
        };
      }

      // Check if device verification is required
      if (data.data?.requiresDeviceVerification) {
        setRequiresDeviceVerification(true);
        setTempToken(data.data.tempToken);
        setFailedAttempts(0);
        setLoading(false);
        return {
          success: false,
          requiresDeviceVerification: true,
          tempToken: data.data.tempToken,
          message: data.data?.message || 'Device verification required',
        };
      }

      // Login successful
      setFailedAttempts(0);
      setRequires2FA(false);
      setRequiresDeviceVerification(false);
      setLoading(false);

      return {
        success: true,
        user: data.data?.user,
        tokens: data.data?.tokens,
      };
    } catch (err) {
      console.error('Login error:', err);
      setError('An error occurred. Please try again.');
      setLoading(false);
      return {
        success: false,
        message: 'An error occurred. Please try again.',
      };
    }
  };

  /**
   * Verify 2FA code
   */
  const verify2FA = async (code) => {
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/auth/verify-2fa`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tempToken,
          code,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error?.message || '2FA verification failed');
        setLoading(false);
        return {
          success: false,
          message: data.error?.message || '2FA verification failed',
        };
      }

      setRequires2FA(false);
      setTempToken('');
      setLoading(false);

      return {
        success: true,
        user: data.data?.user,
        tokens: data.data?.tokens,
      };
    } catch (err) {
      console.error('2FA error:', err);
      setError('An error occurred. Please try again.');
      setLoading(false);
      return {
        success: false,
        message: 'An error occurred. Please try again.',
      };
    }
  };

  /**
   * Verify device
   */
  const verifyDevice = async (code) => {
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${apiUrl}/auth/verify-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tempToken,
          code,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error?.message || 'Device verification failed');
        setLoading(false);
        return {
          success: false,
          message: data.error?.message || 'Device verification failed',
        };
      }

      setRequiresDeviceVerification(false);
      setTempToken('');
      setLoading(false);

      return {
        success: true,
        user: data.data?.user,
        tokens: data.data?.tokens,
      };
    } catch (err) {
      console.error('Device verification error:', err);
      setError('An error occurred. Please try again.');
      setLoading(false);
      return {
        success: false,
        message: 'An error occurred. Please try again.',
      };
    }
  };

  /**
   * Reset state
   */
  const reset = () => {
    setError('');
    setLoading(false);
    setFailedAttempts(0);
    setRequires2FA(false);
    setRequiresDeviceVerification(false);
    setTempToken('');
  };

  return {
    // State
    loading,
    error,
    failedAttempts,
    requires2FA,
    requiresDeviceVerification,
    tempToken,
    // Methods
    loginUser,
    verify2FA,
    verifyDevice,
    reset,
  };
};

export default useLogin;
