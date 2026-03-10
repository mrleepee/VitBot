#!/bin/bash
cd "$(dirname "$0")"

cleanup() {
  echo "\nShutting down..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Backend
cd backend
source venv/bin/activate
python server.py &
BACKEND_PID=$!
cd ..

# Frontend
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "  VítBot is running!"
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:8000"
echo "  Press Ctrl+C to stop both"
echo ""

wait
