#define _POSIX_C_SOURCE 200809L
#include "OfficeSignals.h"
#include <signal.h>
#include <errno.h>

// This is a process-local cancellation flag, not an input/event hook. The POSIX
// handler performs only the permitted sig_atomic_t store; no Swift/runtime/IO.
static volatile sig_atomic_t received_signal = 0;
static int installed = 0;
static void remember_signal(int value) { received_signal = value; }

int32_t mountains_office_signals_install(void) {
    if (installed) return EALREADY;
    struct sigaction action = {0};
    action.sa_handler = remember_signal;
    if (sigemptyset(&action.sa_mask) != 0) return errno;
    if (sigaction(SIGINT, &action, 0) != 0) return errno;
    if (sigaction(SIGTERM, &action, 0) != 0) return errno;
    installed = 1;
    return 0;
}
int32_t mountains_office_signal_received(void) { return (int32_t)received_signal; }
