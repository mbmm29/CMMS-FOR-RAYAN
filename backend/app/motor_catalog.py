"""Weekly motor temperature and oil sheets from form PMF 25-6.

Groups A and B are the bucket-elevator and chain-conveyor sheets.
"""

MOTOR_GROUPS = {
    'A': {
        'title': 'Group (A) Bucket elevator',
        'places': {
            'feed-1': {
                'title': 'Feed mill 1',
                'machines': [
                    '1060 انتيك 1', '1360 انتيك 2', '1075 انتيك 1', '1375 انتيك 2',
                    '3090 لفل 42', '3390 لفل 42', '3690 لفل 42',
                    '3210 لفل 42', '3510 لفل 42', '3810 لفل 42',
                    '4105 لفل 46', '4505 لفل 46', '4805 لفل 46',
                ],
            },
            'feed-2': {
                'title': 'Feed mill 2',
                'machines': [
                    '1060 انتيك 3', '1360 انتيك 4', '1075 انتيك 3', '1375 انتيك 4',
                    '3090 لفل 42', '3390 لفل 42', '3690 لفل 42',
                    '3210 لفل 42', '3510 لفل 42', '3810 لفل 42',
                    '4105 لفل 46', '4505 لفل 46', '4805 لفل 46',
                ],
            },
            'premix': {
                'title': 'Premix plant',
                'machines': ['1015 لفل 24', '1040 لفل 31'],
            },
            'hull': {
                'title': 'Hull building',
                'machines': ['2001 لفل 36', '2101 لفل 36'],
            },
        },
    },
    'B': {
        'title': 'Group (B) Chain conveyor',
        'places': {
            'feed-1': {
                'title': 'Feed mill 1',
                'machines': [
                    '1050 انتيك 1', '1055 انتيك 1', '1070 انتيك 1',
                    '1350 انتيك 2', '1355 انتيك 2', '1370 انتيك 2',
                    '1385 لفل 31', '1085 لفل 31',
                    '1100 لفل 27', '1110 لفل 27', '1400 لفل 27',
                    '3045 لفل 2.5', '3046 لفل 2.5', '3345 لفل 2.5', '3346 لفل 2.5',
                    '3645 لفل 2.5', '3646 لفل 2.5',
                    '3047 لفل 0', '3347 لفل 0', '3647 لفل 0',
                    'الشوت المباشر',
                    '3205 لفل 3.5', '3505 لفل 3.5', '3805 لفل 3.5',
                    '4100 لفل 0', '4300 لفل 0', '4500 لفل 0',
                    '3215 لفل 39', '3515 لفل 39', '3815 لفل 39',
                    '4120 لفل 31', '4320 لفل 31', '4520 لفل 31',
                    '4140 لفل 31', '4150 لفل 31', '4160 لفل 31',
                    '4170 لفل 31',
                    '7030 لفل 8', '8001 لفل 8', '7130 لفل 8', '7230 لفل 8', '8201 لفل 8',
                    '8205 اوتلود', '8105 اوتلو', '8005 اوتلو',
                ],
            },
            'feed-2': {
                'title': 'Feed mill 2',
                'machines': [
                    '1050 انتيك 1', '1055 انتيك 1', '1070 انتيك 1',
                    '1350 انتيك 2', '1355 انتيك 2', '1370 انتيك 2',
                    '1385 لفل 31', '1085 لفل 31',
                    '1100 لفل 27', '1110 لفل 27', '1400 لفل 27',
                    '3045 لفل 2.5', '3046 لفل 2.5', '3345 لفل 2.5', '3346 لفل 2.5',
                    '3645 لفل 2.5', '3646 لفل 2.5',
                    '3047 لفل 0', '3347 لفل 0', '3647 لفل 0',
                    '3205 لفل 3.5', '3505 لفل 3.5', '3805 لفل 3.5',
                    '4100 لفل 0', '4300 لفل 0', '4500 لفل 0',
                    '4120 لفل 31', '4320 لفل 31', '4520 لفل 31',
                    '4140 لفل 31', '4150 لفل 31', '4160 لفل 31',
                    '4170 لفل 31',
                    '7030 لفل 8', '8001 لفل 8', '7130 لفل 8', '7230 لفل 8', '8201 لفل 8',
                    '8205 اوتلود', '8105 اوتلو', '8005 اوتلو',
                ],
            },
        },
    },
}

OIL_LEVELS = {'', 'good', 'add'}
OIL_CONDITIONS = {'', 'good', 'critical', 'change'}


SHEET_PLACE = 'sheet'


def motor_place(group_key: str, place_key: str):
    group = MOTOR_GROUPS.get(group_key)
    if not group:
        return None
    return group['places'].get(place_key)


def motor_sheet_allowed(group_key: str, place_key: str) -> bool:
    if place_key == SHEET_PLACE and (group_key in MOTOR_GROUPS or group_key == 'pm'):
        return True
    if group_key not in MOTOR_GROUPS:
        return False
    return place_key in MOTOR_GROUPS[group_key]['places']


def motor_catalog_payload():
    groups = []
    for group_key, group in MOTOR_GROUPS.items():
        places = []
        for place_key, place in group['places'].items():
            places.append({
                'key': place_key,
                'title': place['title'],
                'machines': list(place['machines']),
            })
        groups.append({'key': group_key, 'title': group['title'], 'places': places})
    return {
        'form_no': 'PMF 25-6',
        'revision': 'A',
        'frequency': 'Weekly',
        'inspection': 'Motor temperature, oil level and oil condition',
        'groups': groups,
    }
