#!/usr/bin/env python3
import json
import time
import winpty
from pyte import screens, streams

def capture_demo():
    # Configure terminal dimensions
    rows, cols = 24, 80
    screen = screens.Screen(cols, rows)
    stream = streams.ByteStream(screen)
    
    # Start GoatCode process
    pty = winpty.PtyProcess.spawn(["bun", "run", "src/index.ts"], dimensions=(rows, cols))
    
    # Simulate user interaction
    def type_text(text, delay=0.05):
        for char in text:
            pty.write(char.encode())
            time.sleep(delay)
    
    # Record frames
    frames = []
    start_time = time.time()
    
    # Initial prompt
    type_text("goat")
    pty.write(b"\r")
    time.sleep(1)
    
    # Type a command
    type_text("screenshot")
    pty.write(b"\r")
    time.sleep(2)
    
    # Capture frames from screen
    for _ in range(60):  # 6 seconds at 10fps
        data = pty.read(1024)
        if data:
            stream.feed(data)
        
        # Convert screen to frame data
        frame = []
        for y in range(rows):
            row = []
            for x in range(cols):
                char = screen.buffer[y][x].data
                fg = screen.buffer[y][x].fg
                bg = screen.buffer[y][x].bg
                row.append([char, fg, bg, screen.buffer[y][x].bold])
            frame.append(row)
        frames.append(frame)
        time.sleep(0.1)
    
    # Save frames
    with open("docs/demo_frames.json", "w") as f:
        json.dump(frames, f)

if __name__ == "__main__":
    capture_demo()