#!/bin/bash
# Tail CloudWatch logs for the bookings agent Lambda functions.
# Usage:
#   ./scripts/logs.sh              # tail processor logs (default)
#   ./scripts/logs.sh receiver     # tail receiver logs
#   ./scripts/logs.sh processor    # tail processor logs
#   ./scripts/logs.sh both         # tail both in split view
#   ./scripts/logs.sh errors       # show only errors from last 1h

REGION="us-east-1"
RECEIVER_LOG="/aws/lambda/bookings-agent-receiver"
PROCESSOR_LOG="/aws/lambda/bookings-agent-processor"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

case "${1:-processor}" in
  receiver)
    echo -e "${CYAN}📡 Tailing receiver logs...${NC}"
    echo -e "${YELLOW}(Ctrl+C to stop)${NC}"
    aws logs tail "$RECEIVER_LOG" --follow --region "$REGION" --format short
    ;;
  processor)
    echo -e "${CYAN}🤖 Tailing processor logs...${NC}"
    echo -e "${YELLOW}(Ctrl+C to stop)${NC}"
    aws logs tail "$PROCESSOR_LOG" --follow --region "$REGION" --format short
    ;;
  both)
    echo -e "${CYAN}📡🤖 Tailing both receiver + processor logs...${NC}"
    echo -e "${YELLOW}(Ctrl+C to stop)${NC}"
    aws logs tail "$RECEIVER_LOG" --follow --region "$REGION" --format short &
    PID1=$!
    aws logs tail "$PROCESSOR_LOG" --follow --region "$REGION" --format short &
    PID2=$!
    trap "kill $PID1 $PID2 2>/dev/null" EXIT
    wait
    ;;
  errors)
    SINCE="${2:-1h}"
    echo -e "${RED}❌ Errors from last ${SINCE}:${NC}"
    echo ""
    echo -e "${YELLOW}── Receiver ──${NC}"
    aws logs filter-log-events \
      --log-group-name "$RECEIVER_LOG" \
      --region "$REGION" \
      --start-time "$(date -v-${SINCE} +%s000 2>/dev/null || date -d "-${SINCE}" +%s000)" \
      --filter-pattern "ERROR" \
      --query 'events[].message' \
      --output text 2>/dev/null || echo "(no errors)"
    echo ""
    echo -e "${YELLOW}── Processor ──${NC}"
    aws logs filter-log-events \
      --log-group-name "$PROCESSOR_LOG" \
      --region "$REGION" \
      --start-time "$(date -v-${SINCE} +%s000 2>/dev/null || date -d "-${SINCE}" +%s000)" \
      --filter-pattern "ERROR" \
      --query 'events[].message' \
      --output text 2>/dev/null || echo "(no errors)"
    ;;
  recent)
    SINCE="${2:-30m}"
    echo -e "${GREEN}📋 Recent logs (last ${SINCE}):${NC}"
    echo ""
    aws logs tail "$PROCESSOR_LOG" --region "$REGION" --format short --since "$SINCE"
    ;;
  search)
    PATTERN="${2:-resy}"
    SINCE="${3:-1h}"
    echo -e "${CYAN}🔍 Searching for '${PATTERN}' in last ${SINCE}:${NC}"
    echo ""
    aws logs filter-log-events \
      --log-group-name "$PROCESSOR_LOG" \
      --region "$REGION" \
      --start-time "$(date -v-${SINCE} +%s000 2>/dev/null || date -d "-${SINCE}" +%s000)" \
      --filter-pattern "$PATTERN" \
      --query 'events[].message' \
      --output text
    ;;
  *)
    echo "Usage: ./scripts/logs.sh [receiver|processor|both|errors|recent|search]"
    echo ""
    echo "Commands:"
    echo "  receiver          Tail receiver Lambda logs"
    echo "  processor         Tail processor Lambda logs (default)"
    echo "  both              Tail both in parallel"
    echo "  errors [time]     Show errors from last time period (default: 1h)"
    echo "  recent [time]     Show recent logs (default: 30m)"
    echo "  search [pat] [t]  Search logs for pattern (default: 'resy', last 1h)"
    ;;
esac
