"""Spine rules recovered from the six named WhiteWall paper templates, in mm."""
import math

RULES = {
    'paper-digital-glossy': (8.2, 1.1, 16),
    'paper-digital-highgloss': (8.2, 1.1, 16),
    'paper-digital-matte': (8.4, 1.5, 16),
    'paper-fujiCrystal-glossy': (11, 1.5, 8),
    'paper-fujiCrystal-semi-matte': (11, 1.5, 8),
    'paper-fujiCrystal-velvet': (11, 1.5, 8),
}


def spine_width_mm(paper, pages):
    if paper not in RULES:
        raise ValueError(f'Unknown WhiteWall paper: {paper}')
    base, increment, step = RULES[paper]
    return round(base + increment * math.floor((pages - 28) / step), 3)
