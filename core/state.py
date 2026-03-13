from enum import Enum, auto


class EngineState(Enum):
    IDLE = auto()
    CAPTURING = auto()
    ANALYZING = auto()
    RESPONDING = auto()
    SENDING = auto()
    COOLDOWN = auto()
    PAUSED = auto()      # 人工介入或 kill switch
    STOPPED = auto()


class StateManager:
    def __init__(self):
        self.state = EngineState.IDLE
        self._listeners = []

    def set(self, new_state: EngineState):
        old = self.state
        self.state = new_state
        for fn in self._listeners:
            fn(old, new_state)

    def on_change(self, fn):
        self._listeners.append(fn)

    @property
    def is_running(self) -> bool:
        return self.state not in (EngineState.STOPPED, EngineState.PAUSED)
