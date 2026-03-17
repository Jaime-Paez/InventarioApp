from .signals import set_current_user


class AuditMiddleware:
    """Clean up the thread-local audit user after each request.

    The user is set by AuditTokenAuthentication / AuditSessionAuthentication
    (which run inside DRF view processing, after this middleware has passed).
    This middleware is responsible only for cleanup so the slot doesn't leak
    between requests in threaded/async environments.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            return self.get_response(request)
        finally:
            set_current_user(None)
