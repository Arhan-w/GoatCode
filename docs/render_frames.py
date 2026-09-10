#!/usr/bin/env python3
import json
from PIL import Image, ImageDraw, ImageFont

def render_frames():
    # Load frames
    with open("docs/demo_frames.json", "r") as f:
        frames = json.load(f)
    
    rows = len(frames[0])
    cols = len(frames[0][0])
    cell_w, cell_h = 10, 21
    
    # Find global content bottom (avoid PIL cropping later frames)
    content_bottom = 0
    for frame in frames:
        for y in range(rows):
            if any(cell[0] != ' ' for cell in frame[y]):
                content_bottom = max(content_bottom, y + 1)
    
    # Setup fonts (probe for symbol support)
    try:
        font = ImageFont.truetype("consola.ttf", 17)
    except:
        font = ImageFont.load_default()
    
    # Create GIF frames
    images = []
    for frame in frames:
        img = Image.new('RGB', (cols * cell_w, content_bottom * cell_h), (10, 12, 23))
        draw = ImageDraw.Draw(img)
        
        # Draw content
        for y in range(content_bottom):
            for x in range(cols):
                char, fg, bg, bold = frame[y][x]
                if char == ' ':
                    continue
                
                # Convert hex colors to RGB
                fg_rgb = tuple(int(fg[i:i+2], 16) for i in (0, 2, 4)) if len(fg) == 6 else (224, 224, 255)
                bg_rgb = tuple(int(bg[i:i+2], 16) for i in (0, 2, 4)) if len(bg) == 6 else (10, 12, 23)
                
                # Draw background
                if bg != 'default':
                    draw.rectangle([x*cell_w, y*cell_h, (x+1)*cell_w, (y+1)*cell_h], fill=bg_rgb)
                
                # Draw character
                if char != ' ':
                    draw.text((x*cell_w, y*cell_h), char, font=font, fill=fg_rgb)
        
        # Add title bar (traffic light style)
        draw.rectangle([0, 0, cols*cell_w, 3], fill=(40, 45, 60))
        draw.ellipse([5, 5, 15, 15], fill=(255, 85, 85))  # red
        draw.ellipse([20, 5, 30, 15], fill=(245, 180, 45))  # yellow
        draw.ellipse([35, 5, 45, 15], fill=(66, 185, 138))  # green
        
        # Add accent bar
        draw.rectangle([0, content_bottom*cell_h-2, cols*cell_w, content_bottom*cell_h], fill=(94, 106, 210))
        
        images.append(img)
    
    # Save as GIF
    images[0].save('videos/terminal-demo.gif', save_all=True, append_images=images[1:], 
                  duration=100, loop=0, optimize=True)

if __name__ == "__main__":
    render_frames()