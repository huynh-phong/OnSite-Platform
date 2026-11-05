import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminHome, AdminOrders } from './admin';
import { CatalogPage, CustomerHome, CustomerOrderPage, CustomerOrders } from './customer';
import { LoginPage, RequireRole, Shell } from './Layout';
import { homeFor, useSession, type Role } from './session';
import { AdminOrderPage, AdminTasks, ReviewsPage, StaffHistory, StaffHome, TaskPage } from './staff';

function Home() {
  const { session } = useSession();
  return <Navigate to={session ? homeFor(session.role) : '/login'} replace />;
}

const guard = (role: Role, element: JSX.Element) => <RequireRole role={role}>{element}</RequireRole>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route path="/customer" element={guard('customer', <CustomerHome />)} />
        <Route path="/customer/catalog" element={guard('customer', <CatalogPage />)} />
        <Route path="/customer/orders" element={guard('customer', <CustomerOrders />)} />
        <Route path="/customer/orders/:id" element={guard('customer', <CustomerOrderPage />)} />
        <Route path="/staff" element={guard('staff', <StaffHome />)} />
        <Route path="/staff/history" element={guard('staff', <StaffHistory />)} />
        <Route path="/staff/tasks/:id" element={guard('staff', <TaskPage />)} />
        <Route path="/staff/reviews" element={guard('staff', <ReviewsPage />)} />
        <Route path="/admin" element={guard('admin', <AdminHome />)} />
        <Route path="/admin/orders" element={guard('admin', <AdminOrders />)} />
        <Route path="/admin/orders/:id" element={guard('admin', <AdminOrderPage />)} />
        <Route path="/admin/tasks" element={guard('admin', <AdminTasks />)} />
        <Route path="/admin/tasks/:id" element={guard('admin', <TaskPage readOnly />)} />
        <Route path="/admin/reviews" element={guard('admin', <ReviewsPage />)} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
