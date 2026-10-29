#pragma once
namespace navigation {
struct Point {
    double x;
    double y;
};
class PositionSource {
public:
    virtual Point position() const = 0;
};
class Resettable {
public:
    virtual void reset() = 0;
};
template<typename T>
class Tracker : public PositionSource, public Resettable {
public:
    Tracker();
    Point position() const override;
    void reset() override;
    int update(int value);
    double update(double value);
private:
    T state;
};
}
