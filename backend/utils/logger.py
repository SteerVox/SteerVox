import logging
from logging.handlers import RotatingFileHandler

from utils.branding import BACKEND_LOG_FILE_NAME, LOGGER_NAME
from utils.paths import get_fallback_log_file, get_logs_dir, safe_chmod

class LoggerSetup:
    """
    Configures a structured rotated file logger.
    Logs are saved to the app logs directory to ensure they are easily accessible
    but don't clutter the main application directory.
    
    In the future, we can add a custom WebSocketHandler to stream these to the UI.
    """
    
    _is_setup = False
    
    @classmethod
    def setup(cls) -> logging.Logger:
        if cls._is_setup:
            return logging.getLogger(LOGGER_NAME)
        
        logger = logging.getLogger(LOGGER_NAME)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False

        if logger.handlers:
            cls._is_setup = True
            return logger
        
        # Format: [2024-03-01 12:00:00] [INFO] [module]: message
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        file_handler = cls._build_file_handler(formatter)
        if file_handler:
            logger.addHandler(file_handler)
        
        # Console Handler for local CLI debugging
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        console_handler.setLevel(logging.INFO)
        
        logger.addHandler(console_handler)
        
        cls._is_setup = True
        return logger

    @classmethod
    def _build_file_handler(cls, formatter: logging.Formatter) -> RotatingFileHandler | None:
        for log_file in (get_logs_dir() / BACKEND_LOG_FILE_NAME, get_fallback_log_file()):
            try:
                log_file.parent.mkdir(parents=True, exist_ok=True)
                handler = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=3)
                safe_chmod(log_file, 0o600)
                handler.setFormatter(formatter)
                handler.setLevel(logging.DEBUG)
                return handler
            except OSError:
                continue
        return None

    @classmethod
    def reset(cls) -> None:
        logger = logging.getLogger(LOGGER_NAME)
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)
        cls._is_setup = False

# Global instance getter
def get_logger() -> logging.Logger:
    return LoggerSetup.setup()
