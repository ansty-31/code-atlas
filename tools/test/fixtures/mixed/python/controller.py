"""Python side of a mixed project; no implicit cross-language calls."""
class Controller:
    def step(self, samples: list[int]) -> int:
        if samples and len(samples) > 1:
            return samples[-1]
        return 0


def main() -> None:
    print("位置 <tracker>")
