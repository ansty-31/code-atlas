#include "model.hpp"
namespace navigation {
int distance(Point a, Point b) {
    if (a.x > b.x && a.y > b.y) return 1;
    return 0;
}
template<typename T>
Tracker<T>::Tracker() : state{} {}
template<typename T>
void Tracker<T>::reset() { state = T{}; }
}
