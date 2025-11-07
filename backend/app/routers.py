from collections import OrderedDict

from rest_framework import routers


class CustomRouter(routers.DefaultRouter):
    class APIRootView(routers.APIRootView):
        """Api Grouped Root"""

        def get(self, request, *args, **kwargs):
            response = super().get(request, *args, **kwargs)
            grouped = OrderedDict()
            for key, value in response.data.items():
                section, _, endpoint = key.partition("/")
                if not endpoint:
                    section = "general"
                    endpoint = key
                section_dict = grouped.setdefault(section, OrderedDict())
                section_dict[endpoint] = value
            response.data = grouped
            return response
