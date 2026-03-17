"""
Custom DRF authentication classes that, upon successful auth, store the
authenticated user in thread-local storage so audit signal handlers can
record who performed each database operation.

Token authentication happens inside DRF views, AFTER Django middleware, so
we cannot rely on a plain middleware to read request.user for API calls that
use token auth.
"""
from rest_framework.authentication import SessionAuthentication, TokenAuthentication

from .signals import set_current_user


class AuditTokenAuthentication(TokenAuthentication):
    def authenticate(self, request):
        result = super().authenticate(request)
        if result is not None:
            user, _ = result
            set_current_user(user)
        return result


class AuditSessionAuthentication(SessionAuthentication):
    def authenticate(self, request):
        result = super().authenticate(request)
        if result is not None:
            user, _ = result
            set_current_user(user)
        return result
